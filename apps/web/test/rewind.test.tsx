// SPDX-License-Identifier: AGPL-3.0-only
// Rewind to here on a thread's earlier replies: where the button stands, what
// the dialog offers and says before the click, what it asks the host, how a
// refusal reads in place, Undo rewind on the thread's menu, and the transcript
// read again when a rewind lands. A fixture api; no live host.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REWIND_WORKING_LINE, UNDO_REWIND_LINE, rewindNote, type EventUnion, type HarnessCatalog, type SessionEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { TABLE_CATALOG, whenAgentsAnswered } from "./agents.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { RewindDialogHost } from "../src/components/chat/RewindDialog.js";
import { requestUndoRewind } from "../src/shell/shellRequests.js";
import { resolveActions } from "../src/actions/registry.js";
import { threadActions, type ThreadTarget } from "../src/actions/threadActions.js";

let restoreLayout: () => void = () => {};
beforeAll(() => {
  restoreLayout = installFakeLayout();
});
afterAll(() => restoreLayout());

const WS = "ws_rewind";
const THREAD = "thr_rewind";
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
};

/** One finished turn of the thread: the person's ask, the agent's reply, and what its end kept. */
const turn = (n: number, kept: { ref?: string; anchor?: string } | null): SessionEvent[] => {
  const s = { workspaceId: WS, sessionId: "sess_1", turnId: `turn_${n}`, threadId: THREAD };
  return [
    { type: "session.start", ...s, at: n * 60_000, prompt: `ask ${n}` },
    { type: "session.delta", ...s, at: n * 60_000 + 1, kind: "text", text: `reply ${n}` },
    { type: "session.done", ...s, at: n * 60_000 + 2, result: { status: "completed", durationMs: 1_000 } },
    { type: "session.end", ...s, at: n * 60_000 + 3, exitCode: 0, sawResult: true },
    ...(kept === null ? [] : [{ type: "session.checkpoint" as const, ...s, ...kept }]),
  ];
};
const HISTORY: SessionEvent[] = [...turn(1, { ref: "refs/wsp/checkpoints/api/thr_rewind/turn_1", anchor: "a1" }), ...turn(2, null), ...turn(3, { ref: "refs/wsp/checkpoints/api/thr_rewind/turn_3", anchor: "a3" })];
const ROW: SessionView = { id: "sess_1", workspaceId: WS, harness: "claude", status: "completed", threadId: THREAD, claudeSessionId: "sess_1" };
const CUTS: HarnessCatalog = { ...TABLE_CATALOG, rewindsConversation: true };

function fixtureApi(o: { catalog?: HarnessCatalog; rewind?: Api["rewindThread"]; history?: SessionEvent[] } = {}) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const rewound: { threadId: string; turnId: string; files: boolean }[] = [];
  const undone: string[] = [];
  const reads = { history: 0 };
  const api: Api = {
    portReach: async () => ({ url: "https://x/", expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => {
      reads.history += 1;
      return o.history ?? HISTORY;
    },
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [workspace],
    getWorkspace: async () => workspace,
    createWorkspace: async () => workspace,
    nap: async () => workspace,
    wake: async () => workspace,
    capabilities: async () => caps(),
    listSessions: async () => [ROW],
    listHarnesses: async () => [o.catalog ?? CUTS],
    watchStatuses: async () => [],
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getGolden: async () => undefined,
    startSession: async () => ROW,
    interruptSession: async () => "accepted",
    rewindThread:
      o.rewind ??
      (async (threadId, turnId, files) => {
        rewound.push({ threadId, turnId, files });
        return { turns: 2, ...(files ? { files: 3 } : {}) };
      }),
    undoRewind: async threadId => {
      undone.push(threadId);
      return { turns: 0, files: 3 };
    },
  };
  const emit = (e: EventUnion) =>
    act(() => {
      for (const fn of [...listeners]) fn(e);
    });
  return { api, rewound, undone, reads, emit };
}

async function mount(api: Api) {
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  useStore.getState().select(WS, THREAD);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  await whenAgentsAnswered();
  const view = render(
    <>
      <WorkspaceThread workspaceId={WS} threadId={THREAD} />
      <RewindDialogHost />
    </>,
  );
  await screen.findByText("reply 3");
  return view;
}

const rewindButtons = () => screen.queryAllByRole("button", { name: "Rewind to here" });
/** The reply a button sits under, read off the row the button is in. */
const replyOf = (button: HTMLElement) => button.closest("[data-timeline-row-id]")?.textContent ?? "";

beforeEach(() => {
  useStore.setState({ sessions: {} });
});

describe("Rewind to here on a thread's replies", () => {
  it("stands on an earlier reply whose turn kept a checkpoint, and on no latest reply nor one that kept nothing", async () => {
    const { api } = fixtureApi();
    await mount(api);
    await waitFor(() => expect(rewindButtons()).toHaveLength(1));
    expect(replyOf(rewindButtons()[0]!)).toContain("reply 1");
  });

  it("opens the dialog on the conversation alone, says what goes before the click, and asks the host with the choice made", async () => {
    const { api, rewound } = fixtureApi();
    await mount(api);
    await waitFor(() => expect(rewindButtons()).toHaveLength(1));
    fireEvent.click(rewindButtons()[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Rewind to here?");
    const only = within(dialog).getByRole("radio", { name: "Conversation only" });
    const both = within(dialog).getByRole("radio", { name: "Conversation and files" });
    expect(only.getAttribute("aria-checked")).toBe("true");
    expect(dialog.textContent).toContain(rewindNote({ turns: 2, files: false, cutsConversation: true, agent: "Claude Code" }));
    fireEvent.click(both);
    expect(dialog.textContent).toContain(rewindNote({ turns: 2, files: true, cutsConversation: true, agent: "Claude Code" }));
    // Nothing is lost for good, so the primary is not the red one.
    const primary = within(dialog).getByRole("button", { name: "Rewind" });
    expect(primary.className).not.toContain("bg-destructive");
    fireEvent.click(primary);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(rewound).toEqual([{ threadId: THREAD, turnId: "turn_1", files: true }]);
  });

  it("shows the host's refusal in the note's place and keeps the dialog open", async () => {
    const { api } = fixtureApi({ rewind: vi.fn(async () => Promise.reject(new Error(REWIND_WORKING_LINE))) });
    await mount(api);
    await waitFor(() => expect(rewindButtons()).toHaveLength(1));
    fireEvent.click(rewindButtons()[0]!);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Rewind" }));
    await waitFor(() => expect(dialog.querySelector("[data-k='rewind-refusal']")?.textContent).toContain(REWIND_WORKING_LINE));
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });

  it("on an agent that keeps its own history offers the files alone and says why", async () => {
    const { api, rewound } = fixtureApi({ catalog: { ...TABLE_CATALOG, harness: "claude", label: "Cursor" } });
    await mount(api);
    await waitFor(() => expect(rewindButtons()).toHaveLength(1));
    fireEvent.click(rewindButtons()[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByRole("radio", { name: "Conversation only" })).toBeNull();
    expect(dialog.textContent).toContain(rewindNote({ turns: 2, files: true, cutsConversation: false, agent: "Cursor" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Rewind" }));
    await waitFor(() => expect(rewound).toEqual([{ threadId: THREAD, turnId: "turn_1", files: true }]));
  });

  it("reads the transcript again when a rewind lands, from this window or another", async () => {
    const { api, reads, emit } = fixtureApi();
    await mount(api);
    const before = reads.history;
    emit({ type: "thread.rewound", workspaceId: WS, threadId: THREAD });
    await waitFor(() => expect(reads.history).toBe(before + 1));
  });
});

describe("Undo rewind", () => {
  const target = (rewound?: boolean): ThreadTarget => ({
    id: THREAD,
    threadId: THREAD,
    sessionId: "sess_1",
    workspaceId: WS,
    harness: "claude",
    title: "ask 1",
    status: "completed",
    ran: true,
    catalog: null,
    state: "running",
    root: null,
    others: [],
    ...(rewound !== undefined ? { rewound } : {}),
  });

  it("is on the thread's menu while the last rewind's files can come back, and not otherwise", () => {
    const verbs = { undoRewind: () => {}, copyText: async () => {} };
    expect(resolveActions(threadActions, target(true), verbs).map(a => a.id)).toContain("undo-rewind");
    expect(resolveActions(threadActions, target(), verbs).map(a => a.id)).not.toContain("undo-rewind");
  });

  it("asks first, says the files come back and the conversation does not, then asks the host", async () => {
    const { api, undone } = fixtureApi();
    await mount(api);
    act(() => requestUndoRewind({ workspaceId: WS, threadId: THREAD }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Undo rewind?");
    expect(dialog.textContent).toContain(UNDO_REWIND_LINE);
    fireEvent.click(within(dialog).getByRole("button", { name: "Undo rewind" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(undone).toEqual([THREAD]);
  });
});
