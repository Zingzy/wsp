// SPDX-License-Identifier: AGPL-3.0-only
// Fork from here: where the button stands on a thread's replies and its
// person's messages, the draft it opens and what that draft sends, the dialog
// where a new branch can be offered, the rule line after a fork's history,
// and the tile card's line. A fixture api; no live host.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { FORK_BRANCH_DAEMON_VERSION, FORK_BRANCH_HEAD_NOTE, FORK_BRANCH_NOTE, HERE_PLACE_ID, forkBranchName, forkDialogLine, forkFolderNote, forkOfLine, forkWhereLine, forkedFromLine, type HarnessCatalog, type PlaceView, type ProjectView, type SessionEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { TABLE_CATALOG, whenAgentsAnswered } from "./agents.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { fakeWire } from "./surface-harness.js";
import { clickIntoEditor, composerEditor, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, StartSessionOptions, WarmAgentOptions } from "../src/protocol/client.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { requestNewThread } from "../src/shell/shellRequests.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { ForkDialogHost } from "../src/components/chat/ForkDialog.js";
import { RewindDialogHost } from "../src/components/chat/RewindDialog.js";
import { forkableMessages, useForkDrafts } from "../src/components/chat/forks.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerFilesStore } from "../src/components/chat/composerFiles.js";
import { tileCardLines } from "../src/sidebar/tileCard.js";
import type { TurnSummary } from "../src/components/chat/adapt.js";

let restoreLayout: () => void = () => {};
beforeAll(() => {
  restoreLayout = installFakeLayout();
});
afterAll(() => restoreLayout());

const WS = "ws_fork";
const THREAD = "thr_source";
const project = { id: "pr_1", name: "the-project", path: "/root/acme", computer: "default" };
const cloud: WorkspaceView = { id: WS, name: "api", machineId: "m1", project, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };
const here: WorkspaceView = { ...cloud, kind: "local", folder: "/root/acme" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** One turn of a thread: the person's ask, the agent's reply, and what its end kept; `running` leaves it open. */
const turn = (n: number, kept: { ref?: string; based?: true; anchor?: string } | null, o: { thread?: string; copiedFrom?: string; running?: boolean } = {}): SessionEvent[] => {
  const s = { workspaceId: WS, sessionId: "sess_1", turnId: `turn_${n}`, threadId: o.thread ?? THREAD, ...(o.copiedFrom !== undefined ? { copiedFrom: o.copiedFrom } : {}) };
  return [
    { type: "session.start", ...s, at: n * 60_000, prompt: `ask ${n}`, requestId: `req_${n}` },
    { type: "session.delta", ...s, at: n * 60_000 + 1, kind: "text", text: `reply ${n}` },
    ...(o.running === true
      ? []
      : [
          { type: "session.done" as const, ...s, at: n * 60_000 + 2, result: { status: "completed" as const, durationMs: 1_000 } },
          { type: "session.end" as const, ...s, at: n * 60_000 + 3, exitCode: 0, sawResult: true },
          ...(kept === null ? [] : [{ type: "session.checkpoint" as const, ...s, ...kept }]),
        ]),
  ];
};
const ref = (n: number) => `refs/wsp/checkpoints/${WS}/${THREAD}/turn_${n}`;
const HISTORY: SessionEvent[] = [...turn(1, { ref: ref(1), based: true, anchor: "a1" }), ...turn(2, { ref: ref(2) }), ...turn(3, { ref: ref(3), anchor: "a3" })];
const ROW: SessionView = { id: "sess_1", workspaceId: WS, harness: "claude", status: "completed", threadId: THREAD, claudeSessionId: "sess_1", prompt: "ask 1" };
const FORKS: HarnessCatalog = { ...TABLE_CATALOG, rewindsConversation: true, forks: true };

function fixtureApi(o: { catalog?: HarnessCatalog; history?: SessionEvent[]; rows?: SessionView[]; workspace?: WorkspaceView } = {}) {
  const started: StartSessionOptions[] = [];
  const warmed: WarmAgentOptions[] = [];
  const api: Api = {
    portReach: async () => ({ url: "https://x/", expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => o.history ?? HISTORY,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [o.workspace ?? cloud],
    getWorkspace: async () => o.workspace ?? cloud,
    createWorkspace: async () => o.workspace ?? cloud,
    nap: async () => o.workspace ?? cloud,
    wake: async () => o.workspace ?? cloud,
    capabilities: async () => caps(),
    listSessions: async () => o.rows ?? [ROW],
    listHarnesses: async () => [o.catalog ?? FORKS],
    watchStatuses: async () => [],
    subscribe: () => () => {},
    getGolden: async () => undefined,
    startSession: async opts => {
      started.push(opts);
      return { ...ROW, id: "sess_fork", threadId: "thr_fork" };
    },
    interruptSession: async () => ({ outcome: "accepted" }),
    rewindThread: async () => ({ turns: 1 }),
    sessionAttachment: async () => ({ mediaType: "image/png", bytes: PNG }),
    warmAgent: async opts => void warmed.push(opts),
  };
  return { api, started, warmed };
}

/** The thread the store has selected, as the app's centre draws it: a new-thread request unpins it. */
function Selected() {
  const workspaceId = useStore(s => s.selectedId);
  const threadId = useStore(s => s.selectedThreadId);
  return workspaceId === null ? null : <WorkspaceThread workspaceId={workspaceId} threadId={threadId} />;
}

async function mount(api: Api, thread = THREAD, wait = "reply 3") {
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  useStore.getState().select(WS, thread);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  await whenAgentsAnswered();
  const view = render(
    <>
      <Selected />
      <RewindDialogHost />
      <ForkDialogHost />
    </>,
  );
  await screen.findAllByText(wait);
  return view;
}

const forkButtons = () => screen.queryAllByRole("button", { name: "Fork from here" });
const rowOf = (button: HTMLElement) => button.closest("[data-timeline-row-id]")?.textContent ?? "";
const forkOn = (text: string): HTMLElement => {
  const found = forkButtons().find(b => rowOf(b).includes(text));
  if (found === undefined) throw new Error(`no Fork from here on ${text}`);
  return found;
};
const banner = () =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>("[data-fork-banner]");
    if (found === null) throw new Error("no banner");
    return found;
  });

beforeEach(() => {
  useStore.setState({ sessions: {}, projects: [], places: [] });
  useForkDrafts.setState({ drafts: {} });
  useComposerDraftStore.setState({ drafts: {} });
  useComposerFilesStore.getState().take(WS);
  provideDaemonWire(WS, null);
});

describe("Fork from here on a thread's messages", () => {
  it("stands on every finished turn's last reply after Copy and Rewind, and on the person's message that opened it, never where its agent named no anchor", async () => {
    const { api } = fixtureApi();
    await mount(api);
    // Turn 2 named no anchor: its reply offers none, and neither does the message that forks through it.
    await waitFor(() => expect(forkButtons().map(rowOf).map(t => t.match(/(ask|reply) \d/)?.[0]).sort()).toEqual(["ask 1", "ask 2", "reply 1", "reply 3"]));
    const meta = forkOn("reply 1").parentElement!;
    expect([...meta.querySelectorAll("button")].map(b => b.getAttribute("aria-label") ?? b.textContent)).toEqual([expect.stringMatching(/Copy/), "Rewind to here", "Fork from here"]);
    const asked = forkOn("ask 1").parentElement!;
    expect([...asked.querySelectorAll("button")].map(b => b.getAttribute("aria-label") ?? b.textContent)).toEqual([expect.stringMatching(/Copy/), "Fork from here"]);
  });

  it("stands on earlier turns while a later one runs, never on the running turn, and nowhere on an agent that does not fork", async () => {
    const running = [...turn(1, { ref: ref(1), anchor: "a1" }), ...turn(2, null, { running: true })];
    const { api } = fixtureApi({ history: running, rows: [{ ...ROW, status: "running" }] });
    const view = await mount(api, THREAD, "reply 2");
    await waitFor(() => expect(forkButtons().map(rowOf).map(t => t.match(/(ask|reply) \d/)?.[0]).sort()).toEqual(["ask 1", "reply 1"]));
    view.unmount();
    useStore.setState({ sessions: {} });
    const plain = fixtureApi({ catalog: { ...TABLE_CATALOG, rewindsConversation: true } });
    await mount(plain.api);
    expect(forkButtons()).toEqual([]);
  });

  it("offers no fork on a steered message, which opened no turn", () => {
    const turns: TurnSummary[] = [{ turnId: "t1", sessionId: "s", state: "completed", replied: true, prompt: "a", model: null, durationMs: null, waitedMs: null, costUsd: null, tokens: null, changes: null, error: null, startedAt: null, completedAt: null, checkpoint: { ref: null, anchor: "a1" } }];
    const msg = (id: string, role: "user" | "assistant", steered = false) => ({ id, kind: "message" as const, createdAt: "", message: { id, role, text: id, turnId: "t1", streaming: false, createdAt: "", updatedAt: "", ...(steered ? { steered: true } : {}) } });
    const picks = forkableMessages(turns, [msg("opened", "user"), msg("steer", "user", true), msg("reply", "assistant")], { forks: true, byCount: false });
    expect([...picks.keys()].sort()).toEqual(["opened", "reply"]);
    expect(picks.get("opened")).toMatchObject({ turnId: null });
  });
});

describe("the fork's draft", () => {
  it("opens at once where nothing can be chosen: a fresh composer under the fork's banner, nothing asked of the host, and the dismiss leaves nothing", async () => {
    const { api, started } = fixtureApi();
    await mount(api);
    await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    fireEvent.click(forkOn("reply 1"));
    const shown = await banner();
    expect(shown.textContent).toContain(forkOfLine("ask 1"));
    expect(shown.textContent).toContain(forkWhereLine(undefined));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(started).toEqual([]);
    fireEvent.click(within(shown).getByRole("button", { name: "Cancel the fork" }));
    await waitFor(() => expect(document.querySelector("[data-fork-banner]")).toBeNull());
    expect(useForkDrafts.getState().drafts).toEqual({});
    expect(started).toEqual([]);
  });

  it("from a reply sends the fork through that turn, with no workspace, agent or folder named", async () => {
    const { api, started } = fixtureApi();
    await mount(api);
    await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    fireEvent.click(forkOn("reply 1"));
    await banner();
    await typeInto(composerEditor(), "list every code word you remember");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ workspaceId: WS, prompt: "list every code word you remember", fork: { threadId: THREAD, turnId: "turn_1" } });
    for (const key of ["thread", "harness", "cwd", "project", "branch"]) expect(started[0]).not.toHaveProperty(key);
  });

  it("from a person's message forks through the turn before it with that message in the draft, and from the first message carries no turn", async () => {
    const { api, started } = fixtureApi();
    await mount(api);
    await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    fireEvent.click(forkOn("ask 2"));
    await waitFor(() => expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("ask 2"));
    expect(useForkDrafts.getState().drafts[WS]?.fork).toEqual({ threadId: THREAD, turnId: "turn_1" });
    fireEvent.submit(document.querySelector("[data-chat-composer-form]")!);
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "ask 2", fork: { threadId: THREAD, turnId: "turn_1" } });
  });

  it("from the thread's first message carries no turn, the message in the draft", async () => {
    const { api } = fixtureApi();
    await mount(api);
    await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    fireEvent.click(forkOn("ask 1"));
    await waitFor(() => expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("ask 1"));
    expect(useForkDrafts.getState().drafts[WS]?.fork).toEqual({ threadId: THREAD, at: 0 });
  });
});

describe("the fork's draft from a message that carried an image", () => {
  it("holds that image in the draft's composer beside the message's words", async () => {
    const made = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:wsp/dot");
    onTestFinished(() => {
      URL.createObjectURL = made;
    });
    const withImage = HISTORY.map(e => (e.type === "session.start" && e.turnId === "turn_2" ? { ...e, attachments: [{ mediaType: "image/png", bytes: 68, name: "dot.png" }] } : e));
    const { api, started } = fixtureApi({ history: withImage });
    await mount(api);
    await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    fireEvent.click(forkOn("ask 2"));
    await waitFor(() => expect(useComposerFilesStore.getState().pending[WS]?.map(f => [f.name, f.mediaType, f.bytes])).toEqual([["dot.png", "image/png", PNG]]));
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "ask 2", fork: { threadId: THREAD, turnId: "turn_1" }, attachments: [{ mediaType: "image/png", bytes: PNG, name: "dot.png" }] });
  });

  it("puts back on the dismiss the words and files the composer held before, since the folder's threads share one draft", async () => {
    const made = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:wsp/dot");
    onTestFinished(() => {
      URL.createObjectURL = made;
    });
    const withImage = HISTORY.map(e => (e.type === "session.start" && e.turnId === "turn_2" ? { ...e, attachments: [{ mediaType: "image/png", bytes: 68, name: "dot.png" }] } : e));
    const { api, started } = fixtureApi({ history: withImage });
    await mount(api);
    await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    useComposerDraftStore.getState().setDraft(WS, { prompt: "half a thought", cursor: 4 });
    const mine = { id: "mine", mediaType: "text/plain", name: "notes.txt", bytes: "aGk=", size: 2 };
    useComposerFilesStore.getState().put(WS, [mine]);
    fireEvent.click(forkOn("ask 2"));
    await waitFor(() => expect(useComposerFilesStore.getState().pending[WS]?.map(f => f.name)).toEqual(["dot.png"]));
    expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("ask 2");
    fireEvent.click(within(await banner()).getByRole("button", { name: "Cancel the fork" }));
    await waitFor(() => expect(useComposerDraftStore.getState().drafts[WS]).toEqual({ prompt: "half a thought", cursor: 4 }));
    expect(useComposerFilesStore.getState().pending[WS]).toEqual([mine]);
    expect(started).toEqual([]);
  });
});

describe("what the composer held before a fork off a person's message", () => {
  const mine = { id: "mine", mediaType: "text/plain", name: "notes.txt", bytes: "aGk=", size: 2 };
  const forkAsk2 = async () => {
    const { api, started } = fixtureApi();
    await mount(api);
    await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    useComposerDraftStore.getState().setDraft(WS, { prompt: "half a thought", cursor: 4 });
    useComposerFilesStore.getState().put(WS, [mine]);
    fireEvent.click(forkOn("ask 2"));
    await waitFor(() => expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("ask 2"));
    await banner();
    return started;
  };
  const heldAgain = async () => {
    await waitFor(() => expect(useComposerDraftStore.getState().drafts[WS]).toEqual({ prompt: "half a thought", cursor: 4 }));
    expect(useComposerFilesStore.getState().pending[WS]).toEqual([mine]);
    expect(useForkDrafts.getState().drafts[WS]).toBeUndefined();
  };

  it("comes back when the person leaves the draft for the source, which never shows the forked message", async () => {
    const started = await forkAsk2();
    act(() => useStore.getState().select(WS, THREAD));
    await heldAgain();
    expect(started).toEqual([]);
  });

  it("comes back once the fork's send is answered", async () => {
    const started = await forkAsk2();
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "ask 2", fork: { threadId: THREAD, turnId: "turn_1" } });
    await heldAgain();
  });

  it("comes back on the banner's dismiss", async () => {
    await forkAsk2();
    fireEvent.click(within(await banner()).getByRole("button", { name: "Cancel the fork" }));
    await heldAgain();
  });
});

describe("a fork's draft and the agent started ahead of a send", () => {
  it("asks for none, since a fork resumes its source's conversation and a process started for a new thread holds none", async () => {
    const { api, started, warmed } = fixtureApi();
    await mount(api);
    // The same box on a new thread that is no fork asks for one as it takes focus.
    act(() => requestNewThread({ workspaceId: WS }));
    await waitFor(() => expect(screen.queryByText("reply 3")).toBeNull());
    clickIntoEditor(composerEditor());
    await waitFor(() => expect(warmed).toHaveLength(1));
    act(() => useStore.getState().select(WS, THREAD));
    await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    fireEvent.click(forkOn("reply 3"));
    await banner();
    clickIntoEditor(composerEditor());
    await typeInto(composerEditor(), "carry on");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ fork: { threadId: THREAD, turnId: "turn_3" } });
    expect(warmed).toHaveLength(1);
  });
});

describe("the fork dialog", () => {
  const offerBranch = (picks = {}) => {
    useStore.setState({
      projects: [{ ...project, git: { top: "/root/acme" } } as ProjectView],
      places: [{ id: HERE_PLACE_ID, daemonVersion: FORK_BRANCH_DAEMON_VERSION } as unknown as PlaceView],
      ...picks,
    });
    provideDaemonWire(WS, fakeWire({ "git.branches": { current: "main", branches: [{ name: "main", oid: "a", committed: 1 }, { name: "main-fork", oid: "b", committed: 1 }] } }));
  };

  it("asks first where a new branch can be offered: This folder and New branch as picks, the branch past every name taken as its fact", async () => {
    const { api, started } = fixtureApi({ workspace: here });
    await mount(api);
    offerBranch();
    await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    fireEvent.click(forkOn("reply 1"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Fork from here");
    expect(dialog.textContent).toContain(forkDialogLine("ask 1"));
    expect(dialog.querySelector("[data-choice='folder']")?.textContent).toContain(forkFolderNote("ask 1"));
    expect(dialog.querySelector("[data-choice='branch']")?.textContent).toContain(FORK_BRANCH_NOTE);
    await waitFor(() => expect(dialog.querySelector("[data-choice='branch']")?.textContent).toContain("main-fork-2"));
    expect(within(dialog).getByRole("radio", { name: /This folder/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(dialog).getByRole("radio", { name: /New branch/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Fork" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await banner()).textContent).toContain(forkWhereLine("main-fork-2"));
    // The strip under the composer names the branch the fork opens on, not the folder's.
    expect(document.querySelector("[data-composer-checkout]")?.textContent).toContain("main-fork-2");
    await typeInto(composerEditor(), "try it on a branch");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ fork: { threadId: THREAD, turnId: "turn_1" }, branch: "main-fork-2" });
  });

  it("says a branch starts at today's commit where the turn's checkpoint stands on none, as one an older daemon took", async () => {
    const { api } = fixtureApi({ workspace: here });
    await mount(api);
    offerBranch();
    await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    fireEvent.click(forkOn("reply 3"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("[data-choice='branch']")?.textContent).toContain(FORK_BRANCH_HEAD_NOTE);
    expect(dialog.querySelector("[data-choice='branch']")?.textContent).not.toContain(FORK_BRANCH_NOTE);
  });

  it("picks New branch where a later turn changed files, and names the branch off the source's", () => {
    const base = { sessionId: "s", replied: true, prompt: null, model: null, durationMs: null, waitedMs: null, costUsd: null, tokens: null, error: null, startedAt: null, completedAt: null };
    const turns = [
      { ...base, turnId: "t1", state: "completed", changes: null, checkpoint: { ref: "r1", based: true, anchor: "a1" } },
      { ...base, turnId: "t2", state: "completed", changes: { from: "a", to: "b", files: [{ path: "b.txt", status: "modified", additions: 1, deletions: 0 }] }, checkpoint: { ref: "r2", anchor: "a2" } },
    ] as unknown as TurnSummary[];
    const reply = (turnId: string) => ({ id: `m_${turnId}`, kind: "message" as const, createdAt: "", message: { id: `m_${turnId}`, role: "assistant" as const, text: "", turnId, streaming: false, createdAt: "", updatedAt: "" } });
    const picks = forkableMessages(turns, [reply("t1"), reply("t2")], { forks: true, byCount: false });
    expect(picks.get("m_t1")).toEqual({ turnId: "t1", checkpoint: "r1", based: true, laterChanged: true });
    expect(picks.get("m_t2")).toEqual({ turnId: "t2", checkpoint: "r2", based: false, laterChanged: false });
    expect(forkBranchName("main", new Set(["main"]), "1a2b3c4d5e")).toBe("main-fork");
    expect(forkBranchName(undefined, new Set(), "1a2b3c4d5e")).toBe("fork-1a2b3c4d");
  });

  it("is not offered where the turn kept no checkpoint, the folder is no git repo, the thread runs on a machine, or this computer's daemon lacks the flag", async () => {
    for (const [workspace, picks, history] of [
      [here, {}, [...turn(1, { anchor: "a1" }), ...turn(2, { ref: ref(2), anchor: "a2" })]],
      [here, { projects: [] }, HISTORY],
      [cloud, {}, HISTORY],
      [here, { places: [{ id: HERE_PLACE_ID, daemonVersion: FORK_BRANCH_DAEMON_VERSION - 1 } as unknown as PlaceView] }, HISTORY],
    ] as const) {
      const { api } = fixtureApi({ workspace, history: [...history] });
      const view = await mount(api, THREAD, "reply 2");
      offerBranch(picks);
      await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
      fireEvent.click(forkOn("reply 1"));
      await banner();
      expect(screen.queryByRole("dialog")).toBeNull();
      view.unmount();
      useForkDrafts.setState({ drafts: {} });
      useStore.setState({ sessions: {} });
    }
  });
});

describe("a fork's page", () => {
  const FORK = "thr_fork";
  const forkHistory: SessionEvent[] = [...turn(1, { ref: ref(1), anchor: "a1" }, { thread: FORK, copiedFrom: THREAD }), ...turn(4, { ref: ref(4), anchor: "a4" }, { thread: FORK }), ...turn(5, { ref: ref(5), anchor: "a5" }, { thread: FORK })];
  const forkRow: SessionView = { id: "sess_f", workspaceId: WS, harness: "claude", status: "completed", threadId: FORK, claudeSessionId: "sess_f", prompt: "ask 4", forkedFrom: { threadId: THREAD, turnId: "turn_1", title: "ask 1" } };

  it("shows the copied history, then the rule line naming the source with Open, which opens it; copied turns fork and never rewind", async () => {
    const { api } = fixtureApi({ history: forkHistory, rows: [forkRow, ROW] });
    await mount(api, FORK, "reply 5");
    const rule = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-fork-rule]");
      if (found === null) throw new Error("no rule line");
      return found;
    });
    expect(rule.textContent).toContain(forkedFromLine("ask 1"));
    const rows = [...document.querySelectorAll("[data-timeline-row-id]")].map(r => r.textContent ?? "");
    const at = rows.findIndex(t => t.includes(forkedFromLine("ask 1")));
    expect(rows.findIndex(t => t.includes("reply 1"))).toBeLessThan(at);
    expect(rows.findIndex(t => t.includes("ask 4"))).toBeGreaterThan(at);
    await waitFor(() => expect(forkButtons().some(b => rowOf(b).includes("reply 1"))).toBe(true));
    const rewinds = screen.queryAllByRole("button", { name: "Rewind to here" }).map(rowOf);
    expect(rewinds.some(t => t.includes("reply 1"))).toBe(false);
    expect(rewinds.some(t => t.includes("reply 4"))).toBe(true);
    fireEvent.click(within(rule).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(useStore.getState().selectedThreadId).toBe(THREAD));
  });

  it("names the title the source had once it is deleted, with no Open", async () => {
    const { api } = fixtureApi({ history: forkHistory, rows: [forkRow] });
    await mount(api, FORK, "reply 5");
    const rule = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-fork-rule]");
      if (found === null) throw new Error("no rule line");
      return found;
    });
    expect(rule.textContent).toContain(forkedFromLine("ask 1"));
    expect(within(rule).queryByRole("button", { name: "Open" })).toBeNull();
  });
});

describe("the fork's tile card", () => {
  it("says where the thread came from, after the started-by line, and the source's card says nothing of it", () => {
    const place = { project: "the-project", projectId: "pr_1", computer: "zingzy's laptop" };
    const fork = tileCardLines({ title: "try another way", place, startedBy: "under lead", forkedFrom: "ask 1", branch: "", harness: "claude", model: null, notes: [] });
    expect(fork.lines.slice(0, 2)).toEqual([{ kind: "started-by", text: "under lead" }, { kind: "forked", text: forkedFromLine("ask 1") }]);
    const source = tileCardLines({ title: "ask 1", place, branch: "", harness: "claude", model: null, notes: [] });
    expect(source.lines.some(l => l.kind === "forked")).toBe(false);
  });
});
