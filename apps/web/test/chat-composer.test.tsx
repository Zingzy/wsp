// SPDX-License-Identifier: AGPL-3.0-only
// The composer on its own: keys, the slash menu over the harness catalog, the
// disabled reasons, and the draft that outlives a tab switch. Same fixture api
// shape as chat.test.tsx; no live daemon.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, HOST_ASLEEP_SEND, composerHeldLine, screenCommandLine, SEND_BLOCK_WORDS, sendRefusal, type EventUnion, type HarnessCatalog, type HostItem, type SessionEvent, type SessionView, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { clickIntoEditor, composerEditor, isEditable, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import { isMacPlatform } from "../src/lib/utils.js";
import type { Api, ConnStatus, ProtocolEvent, StartSessionOptions } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { ContextRing } from "../src/components/chat/ContextMeter.js";
import { RightPanel } from "../src/shell/RightPanel.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";
import { useAsideStore } from "../src/components/chat/asideStore.js";
import { composerSendBlock } from "../src/components/chat/ChatComposer.js";
import { COMPOSER_WORDS } from "../src/components/chat/composerWords.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { SEND_LABEL, WAKE_AND_SEND_LABEL } from "../src/components/chat/ComposerPrimaryActions.js";
import { COMPOSER_STATE_WORDS } from "../src/composer-state-words.js";
import { NOT_READY_NAMES } from "../screenshots/ready.mjs";
import { useComposerModesStore } from "../src/components/chat/composerModesStore.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { requestComposerFocus, requestNewThread } from "../src/shell/shellRequests.js";
import { CHAT_HARNESS, CHAT_STREAM, CHAT_T0, CHAT_TURN, CHAT_WS } from "./fixtures/chat-stream.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices, lastNotice } from "./notice-text.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => useComposerDraftStore.setState({ drafts: {}, queues: {} }));

const WS = CHAT_WS;
const scope = { workspaceId: WS, sessionId: "sess_0001", turnId: CHAT_TURN };
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
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

function fixtureApi(workspaces: WorkspaceView[], history: Record<string, SessionEvent[]> = {}, statuses: WorkspaceStatus[] = [], more: Partial<Api> = {}) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: StartSessionOptions[] = [];
  const interrupted: string[] = [];
  const api: Api = {
    interruptSession: async id => { interrupted.push(id); return "accepted"; },
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async id => history[id] ?? [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => (caps()),
    listSessions: async () => [],
    listHarnesses: async () => [CLAUDE_CATALOG],
    watchStatuses: async () => statuses,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 };
    },
    ...more,
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, started, interrupted, emit };
}

/** The store as a fresh window opens it, then the api bound and the socket put where the case wants it. The
 * catalogs are waited for unless the case is about a composer that has none: a send reads its model and its access
 * out of them, so a composer without them is held and a test that did not wait would be testing that hold. */
async function setup(api: Api, conn: ConnStatus = "live", agents = true) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, harnesses: [], harnessesByWorkspace: {}, launches: {} });
  useStore.getState().bind(api);
  useStore.getState().setConn(conn);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  if (agents) await waitFor(() => expect(useStore.getState().harnesses.length).toBeGreaterThan(0));
  const view = render(<WorkspaceThread workspaceId={WS} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const draft = () => useComposerDraftStore.getState().drafts[WS]?.prompt ?? "";
const sendButton = () => screen.getByRole("button", { name: /Send message|Wake and send|Turn in flight|wsp|Workspace|This workspace|Loading|Connecting/ }) as HTMLButtonElement;
const menuItem = (name: string) => document.querySelector<HTMLElement>(`[data-composer-item-id="provider-slash-command:claude:${name}"]`);
const menuDrawer = () => document.querySelector<HTMLElement>("[data-composer-command-drawer]");
/** The composer has no line above its box, in any state: each sentence is said where its thing stands. */
const noLineAbove = () => {
  expect(document.querySelector("[data-composer-refusal]")).toBeNull();
  expect(document.querySelector("[data-chat-composer] span[role='status']")).toBeNull();
};
/** What the held send button says on hover, or null while nothing holds it. */
const heldHover = () => document.querySelector<HTMLElement>("[data-send-held]")?.getAttribute("data-send-held") ?? null;
/** The menu's own empty state or foot line, or null while it says nothing of the kind. */
const menuNote = () => document.querySelector<HTMLElement>("[data-composer-menu-note]")?.textContent ?? null;

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

  it("with Enter as the send key, the platform's mod with Enter makes a new line; with the mod picked, Enter makes the line and the mod sends", async () => {
    const mod = isMacPlatform(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "one");
    await press(editor, "Enter", mod);
    await waitFor(() => expect(draft()).toBe("one\n"));
    expect(started.length).toBe(0);
    act(() => useStore.setState({ preferences: { ...useStore.getState().preferences, sendWith: "mod-enter" } }));
    await typeInto(editor, "two");
    await press(editor, "Enter");
    await waitFor(() => expect(draft()).toBe("one\ntwo\n"));
    expect(started.length).toBe(0);
    await typeInto(editor, "three");
    await press(editor, "Enter", mod);
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]?.prompt).toBe("one\ntwo\nthree");
    act(() => useStore.setState({ preferences: DEFAULT_PREFERENCES }));
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
/** The menu's headings and its rows in the order they are drawn; a command's own name may hold a colon, so the id is
 * read past the two fields in front of it rather than split to the last one. */
/** The right panel as the shell mounts it for the workspace on screen, open or shut by its own record. */
function PanelHost() {
  const state = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, WS));
  return <div data-panel-host>{state.isOpen ? <RightPanel workspaceId={WS} state={state} mode="inline" /> : null}</div>;
}
const panelOpen = () => selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).isOpen;
const groupLabels = () => [...document.querySelectorAll("[data-composer-command-drawer] [data-slot=command-group-label]")].map(el => el.textContent);
const namesInMenu = () => [...document.querySelectorAll("[data-composer-item-id]")].map(el => (el.getAttribute("data-composer-item-id") ?? "").split(":").slice(2).join(":"));

describe("composer slash menu", () => {
  it("promises no commands before a session announced any", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    expect(composerEditor().getAttribute("aria-placeholder")).toBe("Ask anything");
  });

  it("opens no menu for a slash typed before a session announced any, so nothing answers with an empty state", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(draft()).toBe("/"));
    expect(menuDrawer()).toBeNull();
  });

  it("names the menu in the placeholder once a session announced commands, and a slash opens it on them", async () => {
    const { api } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    expect(editor.getAttribute("aria-placeholder")).toBe("Ask anything, or / for commands");
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
  });

  it("takes the announcement as it lands, with no reload", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    expect(composerEditor().getAttribute("aria-placeholder")).toBe("Ask anything");
    emit({ type: "session.start", ...scope, prompt: "hi", harness: CHAT_HARNESS });
    await waitFor(() => expect(composerEditor().getAttribute("aria-placeholder")).toBe("Ask anything, or / for commands"));
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
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
    // Searching for one finds nothing rather than the screen command, and nothing is drawn: the slot says the name
    // reached nothing, so a drawer under it would say the same in other words.
    await typeInto(editor, "log");
    await waitFor(() => expect(listed()).toEqual([]));
    expect(menuDrawer()).toBeNull();
    noLineAbove();
    expect(heldHover()).toBe("no command here is called /log");
  });

  it("heads each group in sentence case sans, never the caps mono of a section header", async () => {
    const { api } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    await typeInto(composerEditor(), "/");
    await waitFor(() => expect(groupLabels().length).toBeGreaterThan(0));
    for (const label of document.querySelectorAll<HTMLElement>("[data-composer-command-drawer] [data-slot=command-group-label]")) {
      expect(label.className, label.textContent ?? "").not.toMatch(/\buppercase\b|\bfont-mono\b|tracking-/);
      expect(label.className).toContain("text-muted-foreground");
    }
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

  it("typing a screen command and Enter sends nothing: the draft stays and a flyout names wsp's own road for it", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    clearNotices();
    const editor = composerEditor();
    await typeInto(editor, "/login");
    await press(editor, "Enter");
    const line = screenCommandLine(SCREEN_COMMANDS[0]!, CLAUDE_CATALOG, workspace);
    await waitFor(() => expect(lastNotice()).toBe(line));
    expect(line).toContain("Workspace panel");
    noLineAbove();
    expect(started).toHaveLength(0);
    expect(draft()).toBe("/login");
    expect(isEditable(editor)).toBe(true);
    // A command with words after it is still the command, and each Enter says so again.
    clearNotices();
    await typeInto(editor, " opus");
    await press(editor, "Enter");
    await waitFor(() => expect(lastNotice()).toBe(line));
    expect(draft()).toBe("/login opus");
    expect(started).toHaveLength(0);
  });

  it("a block on the send holds the button in its words while it lasts, and the screen command's flyout comes back once it lifts", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/login");
    // The socket drops with the draft still in the box: the box is shut and the held button says why.
    act(() => useStore.getState().setConn("reconnecting"));
    await waitFor(() => expect(heldHover()).toBe(sendRefusal("reconnecting")));
    expect(isEditable(editor)).toBe(false);
    noLineAbove();
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(isEditable(editor)).toBe(true));
    expect(heldHover()).toBeNull();
    clearNotices();
    await press(editor, "Enter");
    await waitFor(() => expect(lastNotice()).toBe(screenCommandLine(SCREEN_COMMANDS[0]!, CLAUDE_CATALOG, workspace)));
    expect(draft()).toBe("/login");
    expect(started).toHaveLength(0);
  });

  it("the line for a sign-in command on this computer names the person's own terminal, not the Workspace panel", async () => {
    const local: WorkspaceView = { ...workspace, kind: "local" };
    const { api, started } = fixtureApi([local]);
    await setup(api);
    const editor = composerEditor();
    clearNotices();
    await typeInto(editor, "/logout");
    await press(editor, "Enter");
    const line = screenCommandLine(SCREEN_COMMANDS[1]!, CLAUDE_CATALOG, local);
    await waitFor(() => expect(lastNotice()).toBe(line));
    expect(line).toContain("this computer");
    noLineAbove();
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
    noLineAbove();
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

  it("groups what the session announced by the source the name itself gave, in the order announced, and filters inside the groups", async () => {
    // A real init names a plugin's command <plugin>:<command> and announces everything else bare.
    const announced = ["compact", "context", "code-review:code-review", "ralph-loop:help", "my-skill", "code-review:apply"];
    const stream: SessionEvent[] = CHAT_STREAM.map(e => (e.type === "session.start" ? { ...e, harness: { ...CHAT_HARNESS, slashCommands: announced } } : e));
    const { api } = fixtureApi([workspace], { [WS]: stream });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuDrawer()).not.toBeNull());
    expect(groupLabels()).toEqual(["Commands", "code-review", "ralph-loop"]);
    // Each group in the order its source was first named, each command in the order the announcement gave it.
    expect(namesInMenu()).toEqual(["compact", "context", "my-skill", "code-review:code-review", "code-review:apply", "ralph-loop:help"]);
    // The keyboard walks the menu as it is drawn: the first row of the first group is the one that is highlighted.
    expect(menuItem("compact")?.className).toContain("bg-accent!");

    // Typing keeps the headings of whatever still matches and drops the rest. Inside a group the ranking decides,
    // as it did before there were groups; the announcement's order is what an unfiltered menu is drawn in.
    await typeInto(editor, "review");
    await waitFor(() => expect(menuItem("compact")).toBeNull());
    expect(groupLabels()).toEqual(["code-review"]);
    expect(namesInMenu()).toEqual(["code-review:apply", "code-review:code-review"]);
  });

  it("holds a lone slash instead of sending it: the send button is held with the reason on its hover, and Enter raises it as a flyout", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuDrawer()).not.toBeNull());
    const line = "a slash on its own is not a command";
    noLineAbove();
    const button = screen.getByRole("button", { name: line }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(heldHover()).toBe(line);
    await press(editor, "Escape");
    await waitFor(() => expect(menuDrawer()).toBeNull());
    clearNotices();
    await press(editor, "Enter");
    await waitFor(() => expect(lastNotice()).toBe(line));
    await act(async () => { fireEvent.click(button); });
    expect(started).toHaveLength(0);
    expect(draft()).toBe("/");
    expect(isEditable(editor)).toBe(true);
    noLineAbove();
  });

  it("holds a slash and a name nothing announced, and lets the same name go once words follow it", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/heapdump");
    const line = "no command here is called /heapdump";
    await waitFor(() => expect(heldHover()).toBe(line));
    noLineAbove();
    expect((screen.getByRole("button", { name: line }) as HTMLButtonElement).disabled).toBe(true);
    await press(editor, "Enter");
    expect(started).toHaveLength(0);
    expect(draft()).toBe("/heapdump");
    // Words after the name are words that may be meant, so the hold lifts and Enter sends them.
    await typeInto(editor, " of the daemon");
    await waitFor(() => expect(heldHover()).toBeNull());
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("/heapdump of the daemon");
  });

  it("sends a slash and a name the session did announce", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/compact");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
    noLineAbove();
    await press(editor, "Escape");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("/compact");
  });

  it("escape dismisses the menu and keeps the draft, and the menu stays shut until the caret leaves its token", async () => {
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
    expect(draft()).toBe("/c");
    expect(menuDrawer()).toBeNull();
    await act(async () => useComposerDraftStore.getState().setDraft(WS, { prompt: "", cursor: 0 }));
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
  });
});

describe("fast", () => {
  const option = (value: string, label: string, extra: object = {}) => ({ value, label, ...extra });
  const MODES_CATALOG: HarnessCatalog = {
    ...CLAUDE_CATALOG,
    models: [
      { ...option("claude-opus-5-5", "Opus 5.5", { isDefault: true, fast: true }), efforts: [], contextWindows: [] },
      { ...option("claude-haiku-4-5-20251001", "Haiku 4.5"), efforts: [], contextWindows: [] },
    ],
    permissionModes: [option("default", "Ask", { isDefault: true }), option("acceptEdits", "Accept edits"), option("plan", "Plan")],
  };
  const withModes = (api: Api): Api => ({ ...api, listHarnesses: async () => [MODES_CATALOG] });
  const options = () => document.querySelector<HTMLElement>("[data-composer-picker='reasoning']");
  const bolt = () => options()?.querySelector("[data-composer-fast-bolt]") ?? null;
  const fastItem = (value: "on" | "off") => document.querySelector<HTMLElement>(`[data-composer-fast='${value}']`);

  beforeEach(() => {
    useComposerModesStore.setState({ fast: {} });
    useComposerOptionsStore.setState({ byWorkspaceId: {}, pickedOn: {} });
  });

  it("offers Fast as On and Off in the model options menu, the button wearing a bolt only while it is on, and a send with it on carries fast", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(withModes(api));
    await waitFor(() => expect(options()).not.toBeNull());
    expect(document.querySelector("[data-composer-mode]")).toBeNull();
    expect(bolt()).toBeNull();
    act(() => options()!.click());
    await waitFor(() => expect(fastItem("on")).not.toBeNull());
    expect(fastItem("off")!.getAttribute("aria-checked")).toBe("true");
    act(() => fastItem("on")!.click());
    await waitFor(() => expect(bolt()).not.toBeNull());
    await typeInto(composerEditor(), "quick one");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.fast).toBe(true);
  });

  it("offers no Fast on a model that has none, and sends nothing of it", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(withModes(api));
    await waitFor(() => expect(options()).not.toBeNull());
    act(() => useComposerModesStore.getState().setFast(WS, true));
    act(() => useComposerOptionsStore.getState().pick(WS, "model", "claude-haiku-4-5-20251001"));
    await waitFor(() => expect(options()).toBeNull());
    await typeInto(composerEditor(), "slow one");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.fast).toBeUndefined();
  });

  it("has no toggle in the footer and no slash command for it, and a plan an agent lists is one more access in the picker", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(withModes(api));
    await waitFor(() => expect(options()).not.toBeNull());
    expect(document.querySelector("[data-composer-mode]")).toBeNull();
    await typeInto(composerEditor(), "/fast");
    expect(document.querySelector("[data-composer-item-id='slash:fast']")).toBeNull();
    const picker = document.querySelector<HTMLElement>("[data-composer-picker='access']")!;
    act(() => picker.click());
    await waitFor(() => expect(document.querySelector("[data-composer-option='plan']")).not.toBeNull());
  });
});

describe("arrow-up recall", () => {
  /** Three finished turns of one thread, each opened by the prompt it names. */
  const threeTurns = (): SessionEvent[] =>
    ["first prompt", "second prompt\nwith a second line", "third prompt"].flatMap((prompt, n) => {
      const turn = { workspaceId: WS, sessionId: "sess_0001", turnId: `turn_r${n}` };
      const at = Date.parse("2026-09-01T01:00:00Z") + n * 60_000;
      return [
        { type: "session.start", ...turn, at, model: "claude-sonnet-4-5", prompt },
        { type: "session.done", ...turn, at: at + 1_000, result: { status: "completed", text: `reply ${n}` } },
        { type: "session.end", ...turn, at: at + 1_100, exitCode: 0, sawResult: true },
      ] as SessionEvent[];
    });

  it("walks the thread's sent prompts back newest first from an empty box, and forward past the newest empties it", async () => {
    const { api } = fixtureApi([workspace], { [WS]: threeTurns() });
    await setup(api);
    await screen.findByText("reply 2");
    const editor = composerEditor();
    clickIntoEditor(editor);
    const seen: string[] = [];
    for (let n = 0; n < 3; n++) {
      await press(editor, "ArrowUp");
      seen.push(draft());
    }
    expect(seen).toEqual(["third prompt", "second prompt\nwith a second line", "first prompt"]);
    await press(editor, "ArrowDown");
    expect(draft()).toBe("second prompt\nwith a second line");
    await press(editor, "ArrowDown");
    expect(draft()).toBe("third prompt");
    await press(editor, "ArrowDown");
    expect(draft()).toBe("");
  });

  it("leaves words the person typed where they are", async () => {
    const { api } = fixtureApi([workspace], { [WS]: threeTurns() });
    await setup(api);
    await screen.findByText("reply 2");
    const editor = composerEditor();
    await typeInto(editor, "half a thought");
    await press(editor, "ArrowUp");
    expect(draft()).toBe("half a thought");
  });
});

describe("composer @ menu", () => {
  const asked: Array<{ op: string; params: Record<string, unknown> | undefined }> = [];
  afterEach(() => {
    provideDaemonWire(WS, null);
    asked.length = 0;
  });

  it("lists the thread folder's files off the daemon, ranks by name, and a pick goes as @path", async () => {
    provideDaemonWire(WS, {
      request: async (op, params) => {
        asked.push({ op, params });
        if (op !== "fs.files") throw new Error(`${op} is not what this case is about`);
        return { files: ["docs/chatv-notes/README.md", "src/components/ChatComposer.tsx", "src/components/ChatView.tsx"], truncated: false };
      },
    });
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "open @chatv");
    const first = await waitFor(() => {
      const rows = document.querySelectorAll<HTMLElement>("[data-composer-item-id^='path:']");
      expect(rows.length).toBeGreaterThan(0);
      return rows[0]!;
    });
    expect(first.dataset["composerItemId"]).toBe("path:src/components/ChatView.tsx");
    expect(asked.filter(call => call.op === "fs.files")).toEqual([{ op: "fs.files", params: { cwd: "/root" } }]);
    act(() => first.click());
    await waitFor(() => expect(editor.querySelector("[data-composer-mention-chip]")?.textContent).toBe("ChatView.tsx"));
    await typeInto(editor, "please");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]?.prompt).toBe("open @src/components/ChatView.tsx please");
  });

  it("undo right after a pick takes the chip back to the words that were typed", async () => {
    provideDaemonWire(WS, { request: async () => ({ files: ["src/components/ChatView.tsx"], truncated: false }) });
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "open @chatv");
    const row = await waitFor(() => document.querySelector<HTMLElement>("[data-composer-item-id='path:src/components/ChatView.tsx']")!);
    act(() => row.click());
    await waitFor(() => expect(editor.querySelector("[data-composer-mention-chip]")).not.toBeNull());
    await press(editor, "z", { ctrlKey: true });
    await waitFor(() => expect(draft()).toBe("open @chatv"));
    expect(editor.querySelector("[data-composer-mention-chip]")).toBeNull();
  });

  /** The composer on a copy on a computer somebody owns, which the menu's lines name as the rest of the app does. */
  const COMPUTER = "old-laptop";
  async function onComputer() {
    await setup(fixtureApi([{ ...workspace, place: "p_oldlaptop" }]).api);
    act(() => useStore.setState({ places: [{ id: "p_oldlaptop", kind: "computer", name: COMPUTER, default: true, present: true }] }));
  }

  it("says in the person's words that a computer whose wsp predates the list has none yet", async () => {
    provideDaemonWire(WS, { request: async () => Promise.reject(Object.assign(new Error("fs.files is not served by this daemon yet"), { code: "unsupported" })) });
    await onComputer();
    await typeInto(composerEditor(), "@c");
    await waitFor(() => expect(menuNote()).toBe(COMPOSER_WORDS.menuListUnserved(COMPUTER)));
    noLineAbove();
    expect(document.body.textContent).not.toContain("daemon");
    expect(document.body.textContent).not.toContain("this computer");
  });

  it("names the computer the copy is on where no signed-in command line lists its pull requests", async () => {
    provideDaemonWire(WS, { request: async () => ({ items: [], noCliFor: "github.com" }) });
    await onComputer();
    await typeInto(composerEditor(), "#4");
    await waitFor(() => expect(menuNote()).toBe(COMPOSER_WORDS.noHostList("github.com", COMPUTER)));
    noLineAbove();
    expect(document.body.textContent).not.toContain("this computer");
  });

  const PR: HostItem = { kind: "pull-request", number: 880, title: "Sidebar section heads", body: "", url: "https://github.com/Zingzy/wsp/pull/880" };
  const prRows = () => document.querySelectorAll("[data-composer-item-id^='reference:']");

  it("# opens the menu the moment it is typed, saying the list is on its way, and fills it when the list answers", async () => {
    let answer: (reply: Record<string, unknown>) => void = () => {};
    provideDaemonWire(WS, {
      request: (op, params) => {
        asked.push({ op, params });
        return new Promise<Record<string, unknown>>(resolve => (answer = resolve));
      },
    });
    const { api } = fixtureApi([workspace]);
    await setup(api);
    await typeInto(composerEditor(), "#");
    // The drawer stands before anything answered.
    expect(menuDrawer()).not.toBeNull();
    expect(menuNote()).toBe(COMPOSER_WORDS.menuLoading["pull-request"]);
    noLineAbove();
    await act(async () => answer({ items: [PR] }));
    await waitFor(() => expect(prRows()).toHaveLength(1));
    expect(menuNote()).toBeNull();
  });

  it("asks for the pull requests and issues when the thread opens, so the first # draws them at once, and every # reads again and replaces them", async () => {
    const LATER: HostItem = { kind: "pull-request", number: 881, title: "Queue cards", body: "", url: "https://github.com/Zingzy/wsp/pull/881" };
    let lists = 0;
    provideDaemonWire(WS, {
      request: async (op, params) => {
        asked.push({ op, params });
        if (op !== "git.prList") return { files: [], truncated: false };
        lists += 1;
        if (lists === 1) return { items: [PR] };
        await new Promise(resolve => setTimeout(resolve, 100));
        return { items: [LATER, PR] };
      },
    });
    const { api } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(asked.filter(call => call.op === "git.prList")).toEqual([{ op: "git.prList", params: { cwd: "/root" } }]));
    await typeInto(composerEditor(), "#");
    // What was read ahead draws with the keystroke, and the token's own read replaces it.
    expect(prRows()).toHaveLength(1);
    await waitFor(() => expect(prRows()).toHaveLength(2));
    expect(asked.filter(call => call.op === "git.prList")).toHaveLength(2);
  });

  it("a repository with nothing open says so in the menu, and a # matching nothing says that", async () => {
    provideDaemonWire(WS, { request: async op => (op === "git.prList" ? { items: [PR] } : { files: [], truncated: false }) });
    const { api } = fixtureApi([workspace]);
    await setup(api);
    await typeInto(composerEditor(), "#zzzz");
    await waitFor(() => expect(menuNote()).toBe(COMPOSER_WORDS.menuNoMatch["pull-request"]));
    expect(prRows()).toHaveLength(0);
    noLineAbove();
  });

  it("a list read that failed says why in the menu, not above the box", async () => {
    provideDaemonWire(WS, { request: async () => Promise.reject(new Error("gh answered 502")) });
    const { api } = fixtureApi([workspace]);
    await setup(api);
    await typeInto(composerEditor(), "#");
    await waitFor(() => expect(menuNote()).toBe("gh answered 502"));
    noLineAbove();
  });

  it("says at the menu's foot that a checkout past the cap is listed only as far as the cap", async () => {
    provideDaemonWire(WS, { request: async () => ({ files: ["src/components/ChatView.tsx"], truncated: true }) });
    const { api } = fixtureApi([workspace]);
    await setup(api);
    await typeInto(composerEditor(), "@chatv");
    await waitFor(() => expect(menuNote()).toBe(COMPOSER_WORDS.filesCut));
    noLineAbove();
    expect(document.querySelector("[data-composer-item-id='path:src/components/ChatView.tsx']")).not.toBeNull();
  });
});

describe("composer chips", () => {
  it("backspace right after a chip removes the chip whole and leaves the text around it", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    clickIntoEditor(editor);
    // The caret sits right after the file chip: "see " is four places and the chip is one.
    act(() => useComposerDraftStore.getState().setDraft(WS, { prompt: "see @src/composer-logic.ts now", cursor: 5 }));
    await waitFor(() => expect(editor.querySelector("[data-composer-mention-chip]")).not.toBeNull());
    await press(editor, "Backspace");
    await waitFor(() => expect(editor.querySelector("[data-composer-mention-chip]")).toBeNull());
    expect(draft()).toBe("see  now");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]?.prompt).toBe("see  now");
  });

  it("sends a chip as the text the agent reads", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    act(() => useComposerDraftStore.getState().setDraft(WS, { prompt: "summarise @apps/web/src/composer-logic.ts please", cursor: 3 }));
    await waitFor(() => expect(editor.querySelector("[data-composer-mention-chip]")?.textContent).toBe("composer-logic.ts"));
    clickIntoEditor(editor);
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]?.prompt).toBe("summarise @apps/web/src/composer-logic.ts please");
  });
});

describe("a side question from the composer", () => {
  /** The thread's row as the runtime lists it: the id a side question names the thread by. */
  const row: SessionView = { id: "sess_local_1", workspaceId: WS, harness: "claude", status: "completed", claudeSessionId: "sess_0001", threadId: "thr_0001", prompt: "go", startedAt: 0 };
  const asking = (asides: boolean) => {
    const asked: Array<{ sessionId: string; question: string }> = [];
    let answer: (text: string) => void = () => {};
    const fixture = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() }, [], {
      listSessions: async () => [row],
      listHarnesses: async () => [{ ...CLAUDE_CATALOG, ...(asides ? { asides: true } : {}) }],
      askAside: (sessionId, question) => {
        asked.push({ sessionId, question });
        return new Promise(resolve => (answer = text => resolve({ text })));
      },
    });
    return { ...fixture, asked, answer: (text: string) => act(() => answer(text)) };
  };
  const btwItem = () => document.querySelector<HTMLElement>('[data-composer-item-id="provider-slash-command:claude:btw"]');

  it("lists /btw under wsp's own heading only where the agent's catalog says it takes one", async () => {
    const off = asking(false);
    const view = await setup(off.api);
    await screen.findByText(/Server is live at :3000\./);
    await typeInto(composerEditor(), "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
    expect(btwItem()).toBeNull();
    view.unmount();
    useComposerDraftStore.setState({ drafts: {}, queues: {} });

    const on = asking(true);
    await setup(on.api);
    await screen.findByText(/Server is live at :3000\./);
    await typeInto(composerEditor(), "/");
    await waitFor(() => expect(btwItem()).not.toBeNull());
    expect(groupLabels()).toEqual(["Commands", "wsp"]);
  });

  it("a /btw send asks the host, starts no turn, and opens the right panel on the side question, which goes from asking to the answer and away on Esc", async () => {
    const { api, started, asked, answer } = asking(true);
    await setup(api);
    render(<PanelHost />);
    await screen.findByText(/Server is live at :3000\./);
    act(() => useRightPanelStore.getState().close(WS));
    expect(panelOpen()).toBe(false);
    const editor = composerEditor();
    await typeInto(editor, "/btw");
    await waitFor(() => expect(heldHover()).toBe("/btw takes a question after it"));
    await press(editor, "Escape");
    await press(editor, "Enter");
    expect(asked).toEqual([]);
    await typeInto(editor, " what did I last ask?");
    await waitFor(() => expect(heldHover()).toBeNull());
    await press(editor, "Escape");
    await press(editor, "Enter");
    await waitFor(() => expect(asked).toEqual([{ sessionId: "sess_local_1", question: "what did I last ask?" }]));
    expect(started).toHaveLength(0);
    expect(draft()).toBe("");
    // Not a dialog and not a strip over the box: the right panel opens on it.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector('[data-chat-composer] [data-k^="aside"]')).toBeNull();
    await waitFor(() => expect(panelOpen()).toBe(true));
    const surface = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-panel-host] [data-k="aside-surface"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(surface.querySelector('[data-k="aside-question"]')?.textContent).toBe("what did I last ask?");
    expect(surface.querySelector('[data-k="aside-asking"]')).not.toBeNull();
    answer("You asked for a hello world server on :3000.");
    await waitFor(() => expect(surface.querySelector('[data-k="aside-answer"]')?.textContent).toContain("You asked for a hello world server on :3000."));
    await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });
    await waitFor(() => expect(document.querySelector('[data-k="aside-surface"]')).toBeNull());
    // The panel was shut before the question, so it shuts again with it.
    expect(panelOpen()).toBe(false);
    // Nothing of it reached the thread: no row in the transcript, no turn.
    expect(screen.queryAllByText(/hello world server/)).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("a side question goes when the composer leaves the thread it was asked from", async () => {
    const { api } = asking(true);
    await setup(api);
    render(<PanelHost />);
    await screen.findByText(/Server is live at :3000\./);
    await typeInto(composerEditor(), "/btw which folder?");
    await press(composerEditor(), "Escape");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(document.querySelector('[data-panel-host] [data-k="aside-surface"]')).not.toBeNull());
    act(() => requestNewThread({ workspaceId: WS }));
    await waitFor(() => expect(document.querySelector('[data-k="aside-surface"]')).toBeNull());
  });

  it("a side question asked with the panel open stands on a tab beside the panel's others, and closing its tab gives the panel back", async () => {
    const { api, answer } = asking(true);
    await setup(api);
    render(<PanelHost />);
    await screen.findByText(/Server is live at :3000\./);
    act(() => useRightPanelStore.getState().open(WS, "machine"));
    await typeInto(composerEditor(), "/btw which folder?");
    await press(composerEditor(), "Escape");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(document.querySelector('[data-panel-host] [data-k="aside-surface"]')).not.toBeNull());
    const tabs = () => [...document.querySelectorAll<HTMLElement>("[data-panel-host] [data-active-tab]")].map(tab => `${tab.textContent}${tab.dataset["activeTab"] === "true" ? "*" : ""}`);
    // One strip: the pane that stood keeps its tab and the side question takes the next one, open on it.
    expect(tabs()).toEqual(["Computer", "Side question*"]);
    answer("/root");
    fireEvent.click(screen.getByRole("button", { name: "Computer" }));
    await waitFor(() => expect(document.querySelector('[data-k="aside-surface"]')).toBeNull());
    expect(tabs()).toEqual(["Computer*", "Side question"]);
    // A tab put aside keeps its answer.
    fireEvent.click(screen.getByRole("button", { name: "Side question" }));
    await waitFor(() => expect(document.querySelector('[data-k="aside-answer"]')?.textContent).toContain("/root"));
    fireEvent.click(screen.getByRole("button", { name: "Close Side question" }));
    await waitFor(() => expect(document.querySelector('[data-k="aside-surface"]')).toBeNull());
    expect(panelOpen()).toBe(true);
    expect(tabs()).toEqual(["Computer*"]);
    expect(useAsideStore.getState().byWorkspace[WS]).toBeUndefined();
  });
});

describe("composer while the workspace is not live", () => {
  it("a paused workspace takes words: no line above the box, the placeholder as always, and the send button reads Wake and send", async () => {
    const { api } = fixtureApi([{ ...workspace, phase: "napping" }]);
    await setup(api);
    expect(isEditable(composerEditor())).toBe(true);
    noLineAbove();
    expect(composerEditor().closest("[data-chat-composer]")!.textContent).not.toContain("paused");
    expect(sendButton().getAttribute("aria-label")).toBe(WAKE_AND_SEND_LABEL);
    expect(sendButton().getAttribute("title")).toBe(WAKE_AND_SEND_LABEL);
    // Empty, so nothing to send yet; the words make it live, as on a running workspace.
    expect(sendButton().disabled).toBe(true);
    await typeInto(composerEditor(), "hello");
    expect(sendButton().disabled).toBe(false);
  });

  it("says it is connecting in the same words the harness that drives this app waits on", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api, "connecting");
    // One file holds the word. The button renders it, and the harness that drives the built app reads it to know
    // the app is not ready for a key press yet; a second spelling in either place puts a driven step back on a
    // page that is still loading, with nothing said about it.
    expect(sendButton().getAttribute("aria-label")).toBe(SEND_BLOCK_WORDS.connecting);
    expect(NOT_READY_NAMES).toContain(SEND_BLOCK_WORDS.connecting);
    // The composer's own states are the other half of that list, and the two names it exports come from the same
    // file, so every word the button can wear has exactly one home.
    expect(NOT_READY_NAMES).toContain(COMPOSER_STATE_WORDS.connecting);
    expect([SEND_LABEL, WAKE_AND_SEND_LABEL]).toEqual([COMPOSER_STATE_WORDS.send, COMPOSER_STATE_WORDS.wakeAndSend]);
  });

  it("a running workspace's button reads plain Send", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    expect(sendButton().getAttribute("aria-label")).toBe(SEND_LABEL);
    expect(sendButton().getAttribute("title")).toBeNull();
  });

  it("a paused workspace woken by something else keeps the words in the box until the person sends them", async () => {
    const { api, emit, started } = fixtureApi([{ ...workspace, phase: "napping" }]);
    await setup(api);
    await waitFor(() => expect(sendButton().getAttribute("aria-label")).toBe(WAKE_AND_SEND_LABEL));
    await typeInto(composerEditor(), "run the tests");
    // The machine comes up on its own, woken from the command line or another window. The words are still the
    // person's: the box holds a draft, never a queued row, so nothing here has a send to make.
    emit({ type: "workspace.status", status: { ...workspace, phase: "running", machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 } });
    await waitFor(() => expect(sendButton().getAttribute("aria-label")).toBe(SEND_LABEL));
    // A send that can be pressed is the accent again, which is how a person sees the wait is over.
    expect(sendButton().className).toContain("bg-foreground");
    expect(started).toHaveLength(0);
    expect(draft()).toBe("run the tests");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("run the tests");
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

  it("hands the sidebar the thread the runtime has written no row for yet", async () => {
    // A workspace nobody has sent to: this send opens a thread, it does not resume one, so no row exists for it.
    const { claudeSessionId: _none, ...fresh } = workspace;
    await setup(fixtureApi([fresh]).api);

    // The transcript draws the message on the send; the runtime writes its row only once the agent announces
    // itself, so between the two the send is the only thing the sidebar can draw for this thread.
    await typeInto(composerEditor(), "read the port list");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(useStore.getState().launches[WS]?.title).toBe("read the port list"));
    expect(useStore.getState().launches[WS]?.harness).toBe("claude");
  });

  it("a refused send takes its row back: it opened no thread", async () => {
    const { claudeSessionId: _none, ...fresh } = workspace;
    const { api } = fixtureApi([fresh]);
    let refuse!: (e: Error) => void;
    api.startSession = () => new Promise((_answer, reject) => (refuse = reject));
    await setup(api);
    await typeInto(composerEditor(), "read the port list");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(useStore.getState().launches[WS]).toBeDefined());
    await act(async () => {
      refuse(new Error("the workspace refused the turn"));
      await Promise.resolve();
    });
    await waitFor(() => expect(useStore.getState().launches[WS]).toBeUndefined());
  });

  it("on a window the host did not serve on this computer, a socket that drops reads as that computer asleep, not as wsp gone", async () => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPath: "/ws", paired: false, version: "0.0.0" };
    try {
      const { api } = fixtureApi([workspace]);
      await setup(api);
      act(() => useStore.getState().setConn("reconnecting"));
      await waitFor(() => expect(heldHover()).toBe(HOST_ASLEEP_SEND));
      expect(heldHover()).not.toBe(sendRefusal("reconnecting"));
      const send = screen.getByRole("button", { name: HOST_ASLEEP_SEND }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      expect(isEditable(composerEditor())).toBe(false);
      // A page the host served on this computer says what it has always said: wsp itself is not running here.
      (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPath: "/ws", paired: true, version: "0.0.0", tokenHash: "a".repeat(64) };
      act(() => useStore.getState().setConn("closed"));
      await waitFor(() => expect(heldHover()).toBe(sendRefusal("closed")));
    } finally {
      delete (window as unknown as { __WSP__?: unknown }).__WSP__;
    }
  });

  it("a window on a sleeping Mac says which computer is asleep, ahead of anything that computer's daemon would say", async () => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPath: "/ws", paired: false, version: "0.0.0" };
    try {
      const here: WorkspaceView = { ...workspace, kind: "local", machineId: "local" };
      const { api } = fixtureApi([here]);
      await setup(api);
      // This window cannot reach the host at all: a daemon on the far side of it is not the block, and the reading
      // of it used to take the slot and read as though the daemon were the reason nothing could be sent.
      act(() => useStore.setState({ statuses: { [WS]: { ...here, machineState: "running", reach: { state: "unreachable" }, size: { cpu: 8, memMb: 16384 }, rateUsdPerHour: 0 } as never } }));
      act(() => useStore.getState().setConn("reconnecting"));
      await waitFor(() => expect(heldHover()).toBe(HOST_ASLEEP_SEND));
      expect(heldHover() ?? "").not.toContain("terminals and files stopped");
    } finally {
      delete (window as unknown as { __WSP__?: unknown }).__WSP__;
    }
  });

  it("a gone machine reads the same way: the gone sentence, one line, no panel", async () => {
    const { api } = fixtureApi([{ ...workspace, phase: "gone" }]);
    await setup(api);
    expect(isEditable(composerEditor())).toBe(false);
    expectHeld(sendRefusal("gone")!);
    expect(sendButton().getAttribute("aria-label")).toBe("This workspace's machine is gone with its disk, so work that was not pushed is lost; rebuild it to send, which brings back its home folder from the last saved nap");
    expect(sendButton().disabled).toBe(true);
  });

  /** The composer on a workspace whose computer went quiet, by the road the places list takes: the row for its
   * computer stops answering while the record still says running. */
  async function onSilentComputer() {
    const onPlace: WorkspaceView = { ...workspace, kind: "cloud", machineId: "ctr_9f", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, place: "p_oldlaptop" };
    const fixture = fixtureApi([onPlace]);
    await setup(fixture.api);
    act(() =>
      useStore.setState({
        places: [
          { id: "here", kind: "computer", name: "this-mac", default: false, present: true },
          { id: "p_oldlaptop", kind: "computer", name: "old-laptop", default: true, present: false, lastSeenAt: new Date(Date.now() - 38 * 60_000).toISOString() },
        ],
      }),
    );
    return fixture;
  }

  it("a workspace on a computer that is not answering keeps its box open and holds the send alone", async () => {
    const { started } = await onSilentComputer();
    const held = composerHeldLine("old-laptop");
    // The standing refusal slot, not a toast: the person reads it where they are typing, and it stays there.
    await waitFor(() => expect(heldHover()).toBe(held));
    expect(held).toBe("held until old-laptop answers");
    // The box takes the words the wait is for. The line above it promises the send goes when the machine answers,
    // and a box that ate every keystroke made that promise a lie for five testers.
    expect(isEditable(composerEditor())).toBe(true);
    await typeInto(composerEditor(), "list the files in this repo");
    expect(draft()).toBe("list the files in this repo");
    // The send is the one thing held, in the tier every held send wears, and it says the same line.
    const send = screen.getByRole("button", { name: held }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.className).toContain("border-input");
    expect(send.className).toContain("bg-(--input-fill)");
    expect(send.className).not.toContain("bg-foreground");
    expect(heldHover()).toBe(held);
    // Not the state table's words, and no machine id where a person reads.
    expect(screen.queryByText(sendRefusal("unreachable")!)).toBeNull();
    expect(heldHover() ?? "").not.toContain("place:");
    noLineAbove();
    // Enter leaves the words where they were typed and starts nothing; the flyout it raises says why, in the same words.
    clearNotices();
    await press(composerEditor(), "Enter");
    expect(started).toHaveLength(0);
    expect(draft()).toBe("list the files in this repo");
    await waitFor(() => expect(lastNotice()).toBe(held));
  });

  it("the message a held composer holds goes on the person's own send once the computer answers, never before", async () => {
    const { started } = await onSilentComputer();
    await waitFor(() => expect(heldHover()).toBe(composerHeldLine("old-laptop")));
    await typeInto(composerEditor(), "run the tests");
    act(() =>
      useStore.setState({
        places: [
          { id: "here", kind: "computer", name: "this-mac", default: false, present: true },
          { id: "p_oldlaptop", kind: "computer", name: "old-laptop", default: true, present: true, lastSeenAt: new Date().toISOString() },
        ],
      }),
    );
    // The computer answers. The words are still the person's: nothing leaves the box until they send it.
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(started).toHaveLength(0);
    expect(draft()).toBe("run the tests");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("run the tests");
  });

  it("a workspace whose machine stopped answering the probe holds the same way, named after where it runs", async () => {
    const { api, emit, started } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    // No places row for a fork at a provider, so the sentence names the fork's own where word rather than falling
    // back to the machine id, which names nothing to the person reading it.
    emit({ type: "workspace.status", status: { ...workspace, phase: "running", machineState: "running", reach: { state: "unreachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 } });
    await waitFor(() => expect(heldHover()).toBe(composerHeldLine("a provider")));
    expect(isEditable(composerEditor())).toBe(true);
    await typeInto(composerEditor(), "check the disk");
    await press(composerEditor(), "Enter");
    expect(started).toHaveLength(0);
    expect(draft()).toBe("check the disk");
    expect(heldHover() ?? "").not.toContain("m1");
  });

  it("nothing above the box takes room, and a waking workspace holds the send button in its words instead", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    noLineAbove();
    emit({ type: "workspace.status", status: { ...workspace, phase: "waking", machineState: "starting", reach: { state: "napping" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 } });
    await waitFor(() => expect(heldHover()).toBe(sendRefusal("waking")));
    noLineAbove();
  });

  it("a pushed pausing status disables the send while the view still says running", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    emit({ type: "workspace.status", status: { ...workspace, phase: "pausing", machineState: "running", reach: { state: "napping" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 } });
    await waitFor(() => expect(heldHover() ?? "").toContain("Workspace is pausing; wake it to send"));
    expect(isEditable(composerEditor())).toBe(false);
  });

  it("disables the editor while the runtime socket is down and comes back with it", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api, "reconnecting");
    expect(isEditable(composerEditor())).toBe(false);
    expect(heldHover() ?? "").toContain("wsp is not running, reconnecting");
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    noLineAbove();
  });

  it("offers stop while a turn streams, with no banner; Enter then queues the message above the box", async () => {
    const { api, emit, interrupted, started } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "go" });
    emit({ type: "session.delta", ...scope, kind: "text", text: "on it" });
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeDefined();
    expect(interrupted).toEqual([]);
    expect(screen.queryByRole("button", { name: /Send message|Turn in flight/ })).toBeNull();
    noLineAbove();
    expect(isEditable(composerEditor())).toBe(true);
    await typeInto(composerEditor(), "follow up");
    await press(composerEditor(), "Enter");
    expect(draft()).toBe("");
    expect(document.querySelector("[data-queued-id] [data-queued-text]")?.textContent).toBe("follow up");
    expect(started).toHaveLength(0);
    emit({ type: "session.done", ...scope, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    emit({ type: "session.end", ...scope, exitCode: 0, sawResult: true });
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["follow up"]));
    expect(document.querySelector("[data-queued-id]")).toBeNull();
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
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in the-project?");
    const editor = composerEditor();
    expect(isEditable(editor)).toBe(true);
    noLineAbove();
    expect(screen.queryByRole("button", { name: "Stop generation" })).toBeNull();
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
    await typeInto(editor, "second thread");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toEqual({ workspaceId: WS, requestId: expect.any(String), prompt: "second thread", harness: "claude" });
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

  it("a thread whose turn replied and runs on says nothing above the box: a message sent now is a queued card", async () => {
    const { api, emit, started } = fixtureApi([workspace], { [WS]: WORKING });
    await setup(api);
    await screen.findByText("On it.");
    emit({ type: "session.done", ...a, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    noLineAbove();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    await typeInto(composerEditor(), "then run the tests");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(document.querySelectorAll("[data-queued-id]")).toHaveLength(1));
    expect(document.querySelector("[data-queued-id]")!.textContent).toContain("then run the tests");
    expect(started).toHaveLength(0);
    noLineAbove();
    // A new thread asked for now owes that turn nothing.
    act(() => requestNewThread({ workspaceId: WS }));
    noLineAbove();
    expect(isEditable(composerEditor())).toBe(true);
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
  });
});

/** The send control itself, queried where it sits rather than by the name it happens to be wearing: a held one
 * wears the reason it is held, which is not a name any list of send words can be written from. */
const sendControl = () => document.querySelector<HTMLButtonElement>('[data-chat-composer-actions="right"] button[type="submit"]')!;

/** The block reads the same wherever a person meets it: the held send's hover, the name a screen reader hears on it,
 * and its native title; nothing is said above the box. */
function expectHeld(words: string): void {
  noLineAbove();
  expect(heldHover()).toBe(words);
  expect(sendControl().getAttribute("aria-label")).toBe(words);
  expect(sendControl().disabled).toBe(true);
  // Held is the outline keycap's surface from ui/button.tsx, not a fainter blue: five testers read a lit arrow over
  // a box that refused them as a screen saying it was ready to send.
  expect(sendControl().className).toContain("border-input");
  expect(sendControl().className).toContain("bg-(--input-fill)");
  expect(sendControl().className).not.toContain("bg-foreground");
  expect(sendControl().className).not.toContain("disabled:opacity-30");
}

describe("a composer that cannot send yet", () => {
  it("an Enter while the link is down keeps the draft and leaves the reason standing in the slot", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "check the redirect chain");
    act(() => useStore.getState().setConn("reconnecting"));
    await waitFor(() => expect(isEditable(editor)).toBe(false));
    expectHeld(SEND_BLOCK_WORDS.reconnecting);
    await press(editor, "Enter");
    expect(draft()).toBe("check the redirect chain");
    expectHeld(SEND_BLOCK_WORDS.reconnecting);
    expect(started).toHaveLength(0);
  });

  it("the line goes when the link is up, the Enter that was dropped is not replayed, and the next one carries the draft once", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "check the redirect chain");
    act(() => useStore.getState().setConn("closed"));
    await waitFor(() => expect(isEditable(editor)).toBe(false));
    await press(editor, "Enter");
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(isEditable(editor)).toBe(true));
    noLineAbove();
    expect(heldHover()).toBeNull();
    expect(sendControl().getAttribute("title")).toBeNull();
    // The link coming back is not a send: the draft is still the person's to change or to throw away.
    expect(started).toHaveLength(0);
    expect(draft()).toBe("check the redirect chain");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("check the redirect chain");
    expect(draft()).toBe("");
  });

  it("a composer whose agents have not answered is held in the catalog's own words, and opens when they land", async () => {
    const { api, started } = fixtureApi([workspace]);
    let answered: HarnessCatalog[] = [];
    api.listHarnesses = async () => answered;
    await setup(api, "live", false);
    expectHeld(SEND_BLOCK_WORDS["no-agents"]);
    expect(isEditable(composerEditor())).toBe(false);
    // The harness that drives the built app waits on this word too, so a driven step cannot land on this window.
    expect(NOT_READY_NAMES).toContain(SEND_BLOCK_WORDS["no-agents"]);
    answered = [CLAUDE_CATALOG];
    await act(async () => { await useStore.getState().loadHarnesses(WS); });
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    noLineAbove();
    expect(heldHover()).toBeNull();
    expect(started).toHaveLength(0);
    await typeInto(composerEditor(), "check the redirect chain");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("check the redirect chain");
  });

  it("the block outranks a file refusal already in the slot, so a held composer says one thing and it is the block", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "look at this");
    act(() => {
      fireEvent.paste(editor, { clipboardData: { files: [new File([new Uint8Array(11 * 1024 * 1024)], "huge.bin")], getData: () => "" } });
    });
    // The refusal stands on the file's own chip, and the block, landing after, holds the send in its own words.
    const chip = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-composer-refused-file="huge.bin"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(chip.textContent).toContain(COMPOSER_WORDS.fileRefused);
    act(() => useStore.getState().setConn("closed"));
    await waitFor(() => expect(isEditable(editor)).toBe(false));
    expectHeld(SEND_BLOCK_WORDS.closed);
    expect(document.querySelector('[data-composer-refused-file="huge.bin"]')).not.toBeNull();
  });
});

describe("composerSendBlock", () => {
  const live = { conn: "live" as const, hasApi: true, state: "running" as const, hydrated: true, agents: true };
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
    expect(composerSendBlock({ ...live, agents: false })).toBe("no-agents");
  });

  it("holds nothing for a daemon this host started: the turn runs on this computer and never went through it", () => {
    // The state word folds a silent daemon into unreachable, which held the box on the computer the app is drawn
    // on while the very same build answered a turn from the command line in two seconds.
    expect(composerSendBlock({ ...live, state: "unreachable", absent: true, daemonOnly: true })).toBeNull();
    // Everything that is about the turn itself still holds it.
    expect(composerSendBlock({ ...live, state: "unreachable", absent: true, daemonOnly: true, hydrated: false })).toBe("loading");
    expect(composerSendBlock({ ...live, state: "unreachable", absent: true, daemonOnly: true, agents: false })).toBe("no-agents");
    expect(composerSendBlock({ ...live, conn: "closed", state: "unreachable", absent: true, daemonOnly: true })).toBe("closed");
    // A computer this host only waits for runs no turn, so its silence holds the box as it did.
    expect(composerSendBlock({ ...live, state: "unreachable", absent: true })).toBe("unreachable");
  });
});

describe("the context ring's Compact context", () => {
  // The reply says what the model held, so the ring draws; the catalog row carries the message the adapter declared.
  const HELD: SessionEvent[] = CHAT_STREAM.map(e => ({ ...e, threadId: "thr_0001" })).map(e => (e.type === "session.done" ? { ...e, result: { ...e.result, tokens: { input: 9, output: 1, context: 50_000, window: 200_000 } } } : e));
  const row: SessionView = { id: "sess_local_1", workspaceId: WS, harness: "claude", status: "completed", claudeSessionId: "sess_0001", threadId: "thr_0001", prompt: "go", startedAt: 0 };
  const compacting = (compacts: string | undefined): Partial<Api> => ({ listSessions: async () => [row], listHarnesses: async () => [{ ...CLAUDE_CATALOG, ...(compacts === undefined ? {} : { compacts }) }] });
  const openCard = async () => {
    const ring = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-context-ring]");
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(ring);
    return waitFor(() => {
      const card = document.querySelector<HTMLElement>("[data-context-card]");
      expect(card).not.toBeNull();
      return card!;
    });
  };

  it("sends the agent's own compaction into the thread as a turn, carrying none of the box's files and leaving the draft", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: HELD.slice() }, [], compacting("/compact"));
    await setup(api);
    render(<ContextRing workspaceId={WS} />);
    await screen.findByText(/Server is live at :3000\./);
    await typeInto(composerEditor(), "half a thought");
    const card = await openCard();
    expect(card.querySelector("[data-context-figures]")?.textContent).toBe("25%50k / 200k");
    fireEvent.click(card.querySelector<HTMLButtonElement>("[data-context-compact]")!);
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toMatchObject({ prompt: "/compact", workspaceId: WS });
    expect(started[0]?.thread).toBe("thr_0001");
    expect(started[0]?.attachments).toBeUndefined();
    expect(draft()).toBe("half a thought");
  });

  it("offers no compaction for an agent whose adapter declares none", async () => {
    const { api } = fixtureApi([workspace], { [WS]: HELD.slice() }, [], compacting(undefined));
    await setup(api);
    render(<ContextRing workspaceId={WS} />);
    const card = await openCard();
    expect(card.querySelector("[data-context-compact]")).toBeNull();
  });

  it("holds the button with the composer's reason while the socket is down", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: HELD.slice() }, [], compacting("/compact"));
    await setup(api);
    render(<ContextRing workspaceId={WS} />);
    await screen.findByText(/Server is live at :3000\./);
    act(() => useStore.getState().setConn("reconnecting"));
    const card = await openCard();
    await waitFor(() => expect(card.querySelector<HTMLButtonElement>("[data-context-compact]")?.disabled).toBe(true));
    expect(card.querySelector("[data-context-compact-held]")?.textContent).toBe(sendRefusal("reconnecting"));
    fireEvent.click(card.querySelector<HTMLButtonElement>("[data-context-compact]")!);
    expect(started.length).toBe(0);
  });
});

describe("typing in a thread outside the composer", () => {
  it("focuses the composer on a printable key typed anywhere that is not a field, and leaves fields, chords and dialogs their keys", async () => {
    const { api } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    (document.activeElement as HTMLElement | null)?.blur();
    const transcript = screen.getByText(/Server is live at :3000\./);
    fireEvent.keyDown(transcript, { key: "h" });
    await waitFor(() => expect(document.activeElement).toBe(editor));

    editor.blur();
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    fireEvent.keyDown(field, { key: "h" });
    expect(document.activeElement).toBe(field);
    field.blur();
    for (const init of [{ key: "k", metaKey: true }, { key: "k", ctrlKey: true }, { key: " " }, { key: "Enter" }, { key: "ArrowDown" }]) {
      fireEvent.keyDown(transcript, init);
      expect(document.activeElement, JSON.stringify(init)).not.toBe(editor);
    }
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    fireEvent.keyDown(transcript, { key: "h" });
    expect(document.activeElement).not.toBe(editor);
    modal.remove();
    field.remove();
  });
});

describe("a file dragged over the chat", () => {
  const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
  const dragData = (files: File[]) => ({ dataTransfer: { files, items: [], types: ["Files"], getData: () => "", dropEffect: "none" } });
  const zone = () => document.querySelector<HTMLElement>("[data-chat-drop-zone]");

  it("shows a drop zone over the whole chat while it is over it, and the drop anywhere in the chat lands in the composer", async () => {
    const { api } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() }, [], { listHarnesses: async () => [{ ...CLAUDE_CATALOG, images: true }] });
    await setup(api);
    const transcript = await screen.findByText(/Server is live at :3000\./);
    const files = [png("shot.png")];
    expect(zone()).toBeNull();
    fireEvent.dragEnter(transcript, dragData(files));
    await waitFor(() => expect(zone()).not.toBeNull());
    expect(zone()!.closest("[data-chat-view]")).not.toBeNull();
    expect(zone()!.textContent).toContain("Drop files to attach");
    fireEvent.dragLeave(transcript, { ...dragData(files), relatedTarget: null });
    await waitFor(() => expect(zone()).toBeNull());

    fireEvent.dragEnter(transcript, dragData(files));
    await waitFor(() => expect(zone()).not.toBeNull());
    const dropped = fireEvent.drop(transcript, dragData(files));
    // The page takes the drop, so the desktop app never opens the file in place of itself.
    expect(dropped).toBe(false);
    await waitFor(() => expect(zone()).toBeNull());
    await waitFor(() => expect(document.querySelector("[data-composer-files]")?.textContent ?? "").not.toBe(""));
  });

  it("ignores a drag that carries no file, such as text selected in the page", async () => {
    const { api } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    const transcript = await screen.findByText(/Server is live at :3000\./);
    fireEvent.dragEnter(transcript, { dataTransfer: { files: [], items: [], types: ["text/plain"], getData: () => "words" } });
    await new Promise(r => setTimeout(r, 20));
    expect(zone()).toBeNull();
  });
});
