// SPDX-License-Identifier: AGPL-3.0-only
// The one drawer on the composer's top edge and the bars its rows open: a busy
// lead's folded question, its tasks and its messages waiting stand as rows,
// most pressing first; a press opens that row's bar in the composer's place and
// the bar's foot folds it back; the question panel still takes the slot when a
// prompt opens, and once it is answered the composer comes back, not a bar. A
// bar takes the focus as it opens, folds on Esc and hands the focus back to the
// composer's field however it closes; a letter typed while it stands lands in
// that field and opens no pane. A keystroke in the composer draws no row again.
// Same fixture api shape as prompt-dock.test.tsx; no live daemon.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const drawn = vi.hoisted(() => ({ glyphs: 0 }));
// A row draws its glyph each time it is drawn itself, and the glyph lives across a module boundary, so counting the
// row glyphs' draws counts the rows' draws behind their real memo.
vi.mock("lucide-react", async importOriginal => {
  const { createElement } = await import("react");
  const real = await importOriginal<typeof import("lucide-react")>();
  const counted = (Glyph: (typeof real)["GaugeIcon"]) => (props: object) => {
    drawn.glyphs++;
    return createElement(Glyph, props);
  };
  return { ...real, MessageCircleQuestionIcon: counted(real.MessageCircleQuestionIcon), GaugeIcon: counted(real.GaugeIcon), ListTodoIcon: counted(real.ListTodoIcon), MessageSquareTextIcon: counted(real.MessageSquareTextIcon) };
});

import { DEFAULT_PREFERENCES, QUESTION_TOOL, questionOptions, type EventUnion, type SessionEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { SlateSurface } from "../src/slate/SlateSurface.js";
import type { SlateApi } from "../src/slate/wire.js";
import { RightPanelTabs } from "../src/components/RightPanelTabs.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { PANE_KINDS, type RightPanelKind } from "../src/panes.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerBarStore } from "../src/components/chat/composerBar.js";
import { TABLE_CATALOG, whenAgentsAnswered } from "./agents.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { installFakeLayout } from "./fake-layout.js";
import { CHAT_T0, CHAT_WS } from "./fixtures/chat-stream.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

let restoreLayout: () => void = () => {};
beforeAll(() => {
  restoreLayout = installFakeLayout();
});
afterAll(() => restoreLayout());
beforeEach(() => {
  window.localStorage.clear();
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
  useComposerBarStore.setState({ open: {}, folded: {} });
  useStore.setState({ preferences: DEFAULT_PREFERENCES });
});

const WS = CHAT_WS;
const T0 = CHAT_T0;
const THREAD = "thr_lead";
const sc = { workspaceId: WS, sessionId: "sess_lead", turnId: "turn_lead", threadId: THREAD };
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
};
const running: SessionView = { id: "sess_lead", threadId: THREAD, workspaceId: WS, harness: "claude", status: "running", prompt: "run the marathon", startedAt: T0 };

const STEPS = ["Read the open tickets on the map", "Start a builder per ticket", "Start a reviewer per pull request", "Run fix rounds until each review passes", "Merge what passed into main", "Report what needs the person"];
/** The list as the agent rewrites it: the first step 74 s, the second 31 s, the third working since. */
const plan = (at: number, done: number): SessionEvent => ({
  type: "session.plan",
  ...sc,
  at,
  steps: STEPS.map((text, n) => ({ text, state: n < done ? "done" : n === done ? "working" : "pending" })),
});
const PICK = { question: "Which ticket should the next free builder take?", header: "Next", multiSelect: false, options: [{ label: "Lead threads (#1830)", description: "" }, { label: "Box thread (#1615)", description: "" }] };
const input = JSON.stringify({ questions: [PICK] });
const asked: SessionEvent = { type: "session.permission", ...sc, at: T0 + 110_000, askId: "ask_next", toolName: QUESTION_TOOL, toolUseId: "toolu_next", input, options: questionOptions(QUESTION_TOOL, input) };

/** Two threads the lead's agent opened, one at work and one failed. */
const CHILDREN: SessionView[] = [
  { id: "sess_build", threadId: "thr_build", workspaceId: WS, harness: "claude", status: "running", startedBy: "agent", parentThreadId: THREAD, prompt: "Build: box thread in the project folder", startedAt: T0 },
  { id: "sess_fix", threadId: "thr_fix", workspaceId: WS, harness: "claude", status: "failed", startedBy: "agent", parentThreadId: THREAD, prompt: "Fix: main's desktop smoke", startedAt: T0 },
];

function fixture(over: { asks?: boolean; steps?: boolean; children?: boolean } = {}) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const history: SessionEvent[] = [
    { type: "session.start", ...sc, at: T0, model: "claude-opus-5-5", prompt: "run the marathon" },
    ...(over.steps === false ? [] : [plan(T0 + 1_000, 0), plan(T0 + 75_000, 1), plan(T0 + 106_000, 2)]),
    ...(over.asks === false ? [] : [asked]),
  ];
  const marks: unknown[] = [];
  const api: Api = {
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => history,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [workspace],
    getWorkspace: async () => workspace,
    createWorkspace: async () => workspace,
    nap: async () => workspace,
    wake: async () => workspace,
    capabilities: async () => caps(),
    listSessions: async () => [running, ...(over.children === true ? CHILDREN : [])],
    listHarnesses: async () => [TABLE_CATALOG],
    watchStatuses: async () => [],
    markThreads: async (...args) => {
      marks.push(args);
    },
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getGolden: async () => undefined,
    startSession: async opts => ({ id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 }),
  };
  const emit = (e: EventUnion) =>
    act(() => {
      for (const fn of [...listeners]) fn(e);
    });
  return { api, emit, marks };
}

async function setup(api: Api, beside: ReactNode = null) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, sessions: {} });
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  await whenAgentsAnswered();
  render(
    <TooltipProvider>
      <WorkspaceThread workspaceId={WS} threadId={THREAD} />
      {beside}
    </TooltipProvider>,
  );
}

/** The right panel with its launcher open, which opens a pane on the bare letter each pane's shortcut names. */
function launcher() {
  const onAdd = vi.fn();
  const all = Object.fromEntries(PANE_KINDS.map(k => [k, true])) as Record<RightPanelKind, boolean>;
  const panel = (
    <RightPanelTabs mode="inline" surfaces={[]} activeSurfaceId={null} previewSessions={{}} terminalLabelsById={new Map()} onActivate={vi.fn()} onCloseSurface={vi.fn()} onAdd={onAdd} available={all}>
      <div />
    </RightPanelTabs>
  );
  return { panel, onAdd };
}

/** Types as a person does: each key's keydown at what holds focus, and a key nobody prevented written into the field
 * that holds focus once its keydown is done, which jsdom leaves to the test. */
async function typeWhereFocused(text: string) {
  for (const key of text) {
    const free = fireEvent.keyDown(document.activeElement ?? document.body, { key });
    await act(async () => {});
    const editor = document.querySelector<HTMLElement>("[data-testid=composer-editor]");
    if (free && editor !== null && document.activeElement === editor) await typeInto(editor, key);
  }
}

const editorFocused = () => expect(document.activeElement).toBe(composerEditor());

const composer = () => document.querySelector("[data-chat-composer-form]");
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-composer-drawer] [data-drawer-row]")];
const row = (bar: string) => document.querySelector<HTMLElement>(`[data-composer-drawer] [data-drawer-row="${bar}"]`)!;
const part = (el: HTMLElement, name: "name" | "line" | "count") => el.querySelector(`[data-drawer-${name}]`)?.textContent ?? null;
const bar = () => document.querySelector<HTMLElement>("[data-composer-bar]");
const back = () => document.querySelector<HTMLElement>("[data-dock-back]")!;

/** Folds the question with Esc, as the person who wants to write first does. */
async function fold() {
  await waitFor(() => expect(document.querySelector("[data-prompt-root]")).not.toBeNull());
  press(document.querySelector("[data-prompt-root]")!, "Escape");
  await waitFor(() => expect(composer()).not.toBeNull());
}

async function enter(text: string) {
  await typeInto(composerEditor(), text);
  await press(composerEditor(), "Enter");
}

describe("the composer's drawer", () => {
  it("holds a busy lead's rows, most pressing first: the folded question, the tasks, the messages waiting", async () => {
    const { api } = fixture();
    await setup(api);
    await fold();
    await waitFor(() => expect(rows().map(r => r.dataset["drawerRow"])).toEqual(["question", "tasks"]));
    expect([part(row("question"), "name"), part(row("question"), "line")]).toEqual(["Waiting for you", PICK.question]);
    expect([part(row("tasks"), "name"), part(row("tasks"), "line"), part(row("tasks"), "count")]).toEqual(["Tasks", STEPS[2], "2/6"]);
    expect(row("tasks").querySelector("[data-drawer-count]")!.className).toContain("font-mono");
    await enter("When 1811 lands, rebase 1866 onto it before its review.");
    await enter("Skip 1830's build until the owner locks the design.");
    await waitFor(() => expect(rows().map(r => r.dataset["drawerRow"])).toEqual(["question", "tasks", "queue"]));
    expect([part(row("queue"), "name"), part(row("queue"), "line")]).toEqual(["2 messages waiting", "When 1811 lands, rebase 1866 onto it before its review."]);
    // One drawer on the box's edge: no card over the box, no strip, no second glass.
    expect(document.querySelector("[data-composer-queue], [data-prompt-strip], [data-limit-strip], [data-composer-tasks]")).toBeNull();
    expect(document.querySelectorAll("[data-composer-drawer]")).toHaveLength(1);
  });

  it("stands no Threads row for a lead with threads under it and opens no Threads bar: the tree stays at the transcript's end", async () => {
    const { api } = fixture({ children: true });
    await setup(api);
    await fold();
    await waitFor(() => expect([...document.querySelectorAll<HTMLElement>("[data-thread-rows] [data-thread-row]")].map(r => r.dataset["threadRow"])).toEqual(["thr_fix", "thr_build"]));
    expect(rows().map(r => r.dataset["drawerRow"])).toEqual(["question", "tasks"]);
    expect(document.querySelector('[data-drawer-row="threads"], [data-composer-bar="threads"]')).toBeNull();
    expect(document.querySelector("[data-composer-drawer]")!.textContent).not.toContain("Threads");
  });

  it("draws no drawer while nothing waits around the composer", async () => {
    const { api } = fixture({ asks: false, steps: false });
    await setup(api);
    await waitFor(() => expect(composer()).not.toBeNull());
    expect(document.querySelector("[data-composer-drawer]")).toBeNull();
    expect(document.querySelector("[data-slot=composer-shell]")!.hasAttribute("data-banner-attached")).toBe(false);
  });

  it("opens the question panel unchanged from its row, and Write a message instead folds it back to the first row", async () => {
    const { api } = fixture();
    await setup(api);
    await fold();
    fireEvent.click(row("question"));
    await waitFor(() => expect(document.querySelector('[data-prompt-dock="ask_next"]')).not.toBeNull());
    expect(composer()).toBeNull();
    expect(document.querySelector("[data-prompt-title]")!.textContent).toBe(PICK.question);
    const write = document.querySelector<HTMLElement>("[data-prompt-write]")!;
    expect(write.textContent).toBe("Write a message instead");
    fireEvent.click(write);
    await waitFor(() => expect(composer()).not.toBeNull());
    expect(rows()[0]!.dataset["drawerRow"]).toBe("question");
  });

  it("opens the Tasks bar in the composer's place, each step with its mark and time, and Write a message folds it back", async () => {
    const { api, marks } = fixture();
    await setup(api);
    await fold();
    fireEvent.click(row("tasks"));
    await waitFor(() => expect(bar()?.dataset["composerBar"]).toBe("tasks"));
    expect(composer()).toBeNull();
    expect(document.querySelector("[data-composer-drawer]")).toBeNull();
    expect(bar()!.querySelector("[data-dock-title]")!.textContent).toBe("Tasks");
    expect(bar()!.querySelector("[data-dock-aside] .font-mono")!.textContent).toBe("2/6");
    const steps = [...bar()!.querySelectorAll<HTMLElement>("[data-step-row]")];
    expect(steps.map(s => s.dataset["state"])).toEqual(["done", "done", "working", "waiting", "waiting", "waiting"]);
    expect(steps.slice(0, 2).map(s => s.querySelector("[data-step-time]")!.textContent)).toEqual(["1m 14s", "31s"]);
    expect(steps[0]!.querySelector("[data-step-time]")!.className).toContain("font-mono");
    // An agent's step at work is the crab, never the loading spinner.
    expect(steps[2]!.querySelector("[data-crab], canvas")).not.toBeNull();
    expect(steps[2]!.querySelector(".animate-spin")).toBeNull();
    // No heading element: the bar is a dialog's step drawn in the composer's frame.
    expect(bar()!.querySelector("h1, h2, h3")).toBeNull();
    expect(back().textContent).toBe("Write a message");
    fireEvent.click(back());
    await waitFor(() => expect(composer()).not.toBeNull());
    expect(bar()).toBeNull();
    // Which bar stands open is this window's alone: the host was never told.
    expect(marks).toEqual([]);
  });

  it("keeps the open bar per thread, in the window", async () => {
    const { api } = fixture();
    await setup(api);
    await fold();
    fireEvent.click(row("tasks"));
    await waitFor(() => expect(bar()).not.toBeNull());
    expect(Object.values(useComposerBarStore.getState().open)).toEqual(["tasks"]);
    act(() => useComposerBarStore.getState().closeBar(Object.keys(useComposerBarStore.getState().open)[0]!));
    await waitFor(() => expect(composer()).not.toBeNull());
  });

  it("draws no drawer row again on a keystroke in the composer", async () => {
    const { api } = fixture();
    await setup(api);
    await fold();
    await enter("rebase it after the review");
    await waitFor(() => expect(rows()).toHaveLength(3));
    const before = drawn.glyphs;
    expect(before).toBeGreaterThan(0);
    await typeInto(composerEditor(), "and then push");
    await typeInto(composerEditor(), " it");
    expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("and then push it");
    expect(rows()).toHaveLength(3);
    expect(drawn.glyphs).toBe(before);
  });

  it("writes a letter typed while a bar stands into the composer's field, and opens no pane for it", async () => {
    const { api } = fixture();
    const { panel, onAdd } = launcher();
    await setup(api, panel);
    await fold();
    fireEvent.click(row("tasks"));
    await waitFor(() => expect(bar()?.dataset["composerBar"]).toBe("tasks"));
    // "the tests" holds the terminal's and the slate's letters.
    await typeWhereFocused("the tests");
    expect(onAdd.mock.calls.map(([kind]) => kind)).toEqual([]);
    await waitFor(() => expect(composer()).not.toBeNull());
    expect(bar()).toBeNull();
    expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("the tests");
    editorFocused();
  });

  it("moves focus into a bar it opens, folds it on Escape and hands focus back to the composer's field", async () => {
    const { api } = fixture();
    await setup(api);
    await fold();
    row("tasks").focus();
    fireEvent.click(row("tasks"));
    await waitFor(() => expect(bar()).not.toBeNull());
    await waitFor(() => expect(bar()!.contains(document.activeElement)).toBe(true));
    press(document.activeElement as HTMLElement, "Escape");
    await waitFor(() => expect(composer()).not.toBeNull());
    expect(bar()).toBeNull();
    await waitFor(editorFocused);
    fireEvent.click(row("tasks"));
    await waitFor(() => expect(bar()!.contains(document.activeElement)).toBe(true));
    fireEvent.click(back());
    await waitFor(() => expect(composer()).not.toBeNull());
    await waitFor(editorFocused);
  });

  it("gives the place back to the composer when the slate's Ask for one writes into it under a bar", async () => {
    const { api } = fixture({ asks: false });
    api.slates = { get: async () => ({ record: null }), subscribe: async () => {}, unsubscribe: async () => {} } as unknown as SlateApi;
    await setup(api, <SlateSurface />);
    act(() => useStore.setState({ selectedId: WS, selectedThreadId: THREAD }));
    await waitFor(() => expect(rows().map(r => r.dataset["drawerRow"])).toEqual(["tasks"]));
    fireEvent.click(row("tasks"));
    await waitFor(() => expect(bar()?.dataset["composerBar"]).toBe("tasks"));
    fireEvent.click(await screen.findByRole("button", { name: "Ask for one" }));
    await waitFor(() => expect(bar()).toBeNull());
    expect(composerEditor().textContent).toBe("Build a slate for this thread that shows ");
    editorFocused();
  });

  it("hands focus to the composer's field when a bar closes by itself", async () => {
    const { api, emit } = fixture({ asks: false });
    await setup(api);
    await waitFor(() => expect(row("tasks")).not.toBeNull());
    fireEvent.click(row("tasks"));
    await waitFor(() => expect(bar()).not.toBeNull());
    emit({ type: "session.done", ...sc, at: T0 + 200_000, result: { status: "completed", durationMs: 200_000 } });
    emit({ type: "session.end", ...sc, at: T0 + 200_001, exitCode: 0, sawResult: true });
    await waitFor(() => expect(composer()).not.toBeNull());
    expect(bar()).toBeNull();
    await waitFor(editorFocused);
  });

  it("gives the place back to the composer once a question that came over an open bar is answered", async () => {
    const { api, emit } = fixture({ asks: false });
    await setup(api);
    await waitFor(() => expect(row("tasks")).not.toBeNull());
    fireEvent.click(row("tasks"));
    await waitFor(() => expect(bar()).not.toBeNull());
    emit(asked);
    await waitFor(() => expect(document.querySelector('[data-prompt-dock="ask_next"]')).not.toBeNull());
    emit({ type: "session.permission.closed", ...sc, at: T0 + 120_000, askId: "ask_next", outcome: "allowed", optionId: "allow" });
    await waitFor(() => expect(document.querySelector("[data-prompt-dock]")).toBeNull());
    await waitFor(() => expect(composer()).not.toBeNull());
    expect(bar()).toBeNull();
    expect(useComposerBarStore.getState().open).toEqual({});
  });
});
