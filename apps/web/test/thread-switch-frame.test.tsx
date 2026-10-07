// SPDX-License-Identifier: AGPL-3.0-only
// What a thread switch does in the frame that draws the next thread: the transcript it leaves stays mounted, hidden
// and inert, until the next one has painted, and a composer whose draft and caret the switch leaves alone takes no
// editor update, whether the switch came from a tile or from a chord that asks for the composer's focus. The next
// thread's rows show once its opening scroll to the end lands, not after a fixed wait, and a turn that starts in the
// seconds after is still followed to its end.
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoldenManifest, HistoryPage, SessionEvent, SessionView, ThreadHead, WorkspaceView } from "@wsp/protocol";
import type { LexicalEditor } from "lexical";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { MessagesTimeline } from "../src/components/chat/MessagesTimeline.js";
import { Shell } from "../src/App.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { installFakeLayout } from "./fake-layout.js";
import { TABLE_CATALOG, whenAgentsAnswered } from "./agents.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices } from "./notice-text.js";
import { goToWorkspace } from "../src/shell/shellCommands.js";
import { clickIntoEditor, composerEditor } from "./composer-harness.js";

const WS = "ws_switch";
const T0 = Date.now() - 60 * 60_000;
const workspace: WorkspaceView = { id: WS, name: "api", machineId: "m_api", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };
const manifest: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "default", kind: "sandbox", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }],
};
const A = { workspaceId: WS, sessionId: "sess_a", turnId: "turn_a", threadId: "thr_a" };
const B = { workspaceId: WS, sessionId: "sess_b", turnId: "turn_b", threadId: "thr_b" };
/** Earlier turns of thread A, enough rows to overflow the list's viewport so it opens with a scroll to its end. */
const EARLIER: SessionEvent[] = Array.from({ length: 6 }, (_, n) => {
  const turn = { ...A, sessionId: `sess_a${n}`, turnId: `turn_a${n}` };
  const at = T0 - (6 - n) * 60_000;
  return [
    { type: "session.start" as const, ...turn, at, prompt: `earlier ask ${n}` },
    { type: "session.delta" as const, ...turn, at: at + 300, kind: "text" as const, text: `earlier reply ${n}` },
    { type: "session.done" as const, ...turn, at: at + 900, result: { status: "completed" as const, durationMs: 900 } },
    { type: "session.end" as const, ...turn, at: at + 950, exitCode: 0, sawResult: true },
  ];
}).flat();
const TRANSCRIPT: SessionEvent[] = [
  ...EARLIER,
  { type: "session.start", ...A, at: T0, prompt: "make me a simple server" },
  { type: "session.delta", ...A, at: T0 + 300, kind: "text", text: "Added GET /health." },
  { type: "session.done", ...A, at: T0 + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
  { type: "session.end", ...A, at: T0 + 950, exitCode: 0, sawResult: true },
  { type: "session.start", ...B, at: T0 + 60_000, prompt: "do you have access" },
  { type: "session.delta", ...B, at: T0 + 60_300, kind: "text", text: "Checking the keychain." },
  { type: "session.done", ...B, at: T0 + 61_000, result: { status: "completed", durationMs: 1_000, costUsd: 0.002 } },
  { type: "session.end", ...B, at: T0 + 61_100, exitCode: 0, sawResult: true },
].map((e, i) => ({ ...e, pos: i + 1 }) as SessionEvent);
const ROWS: SessionView[] = [
  { id: "s_a", workspaceId: WS, harness: "claude", status: "completed", prompt: "make me a simple server", startedAt: T0, endedAt: T0 + 950, threadId: "thr_a" },
  { id: "s_b", workspaceId: WS, harness: "claude", status: "completed", prompt: "do you have access", startedAt: T0 + 60_000, endedAt: T0 + 61_100, threadId: "thr_b" },
];

const listeners = new Set<(e: ProtocolEvent) => void>();
const push = (e: SessionEvent): void => act(() => listeners.forEach(fn => fn(e)));

function hostApi(): Api {
  const row = (threadId: string) => ROWS.find(r => r.threadId === threadId)!;
  return {
    listWorkspaces: async () => [workspace],
    getWorkspace: async () => workspace,
    createWorkspace: async () => workspace,
    watchStatuses: async () => [],
    nap: async () => workspace,
    wake: async () => workspace,
    capabilities: async () => caps(),
    startSession: async o => ({ id: "s_x", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [...TRANSCRIPT],
    sessionHead: async (threadId): Promise<ThreadHead> => {
      const own = TRANSCRIPT.filter(e => e.threadId === threadId);
      const r = row(threadId);
      return { facts: { id: r.id, threadId, workspaceId: WS, harness: r.harness, startedBy: "person", status: r.status, title: r.prompt ?? "", sessionId: r.id, turns: 1, ran: true }, events: own, pos: TRANSCRIPT.length, total: own.length };
    },
    sessionPage: async (_workspaceId, threadId): Promise<HistoryPage> => {
      const own = TRANSCRIPT.filter(e => e.threadId === threadId);
      return { events: own, pos: TRANSCRIPT.length, total: own.length };
    },
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => ROWS,
    listHarnesses: async () => [TABLE_CATALOG],
    workspaceCheckout: async () => ({ checkout: { branch: "main", ahead: 0, behind: 0, changed: 0, readAt: 1 } }),
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getGolden: async () => manifest,
  };
}

class AllInView {
  constructor(private readonly fn: IntersectionObserverCallback) {}
  observe(target: Element): void {
    queueMicrotask(() => this.fn([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** jsdom keeps no scroll offset and has no scrollTo, so the list's viewport could never follow its end. Here its
 * offset clamps to the content as a browser's does, and the scroll event comes on the next frame. */
function installFakeScroller(): () => void {
  const proto = HTMLElement.prototype;
  const offsets = new WeakMap<Element, number>();
  const isViewport = (el: Element) => el.classList.contains("overscroll-y-contain");
  const contentHeight = (el: Element) =>
    [...(el.querySelector(".legend-list-content-container")?.children ?? [])].reduce((sum, child) => sum + (parseFloat((child as HTMLElement).style.height) || (child as HTMLElement).offsetHeight), 0);
  const saved = { top: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!, height: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")! };
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get(this: HTMLElement) { return isViewport(this) ? Math.max(this.clientHeight, contentHeight(this)) : saved.height.get!.call(this); } });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) { return isViewport(this) ? (offsets.get(this) ?? 0) : saved.top.get!.call(this); },
    set(this: HTMLElement, value: number) {
      if (!isViewport(this)) return saved.top.set!.call(this, value);
      offsets.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
      requestAnimationFrame(() => this.dispatchEvent(new Event("scroll")));
    },
  });
  Object.assign(proto, { scrollTo(this: HTMLElement, options: ScrollToOptions) { if (options.top !== undefined) this.scrollTop = options.top; } });
  return () => {
    Reflect.deleteProperty(proto, "scrollHeight");
    Reflect.deleteProperty(proto, "scrollTop");
    Reflect.deleteProperty(proto, "scrollTo");
  };
}

let restoreLayout: () => void = () => {};
beforeAll(() => {
  restoreLayout = installFakeLayout();
  Object.assign(globalThis, { IntersectionObserver: AllInView });
});
afterAll(() => {
  restoreLayout();
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
});
beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false, gaps: 0, settingsOpen: false });
  clearNotices();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  listeners.clear();
});

async function mount() {
  useStore.getState().bind(hostApi());
  await whenAgentsAnswered();
  const { container } = render(<Shell />);
  const sidebar = () => within(container.querySelector<HTMLElement>("[data-app-sidebar]")!);
  const center = () => within(container.querySelector<HTMLElement>("[data-shell-center]")!);
  const threadRow = (title: string): HTMLElement => sidebar().getByText(title).closest<HTMLElement>("[data-sidebar-row]")!;
  await waitFor(() => expect(center().getByText("Checking the keychain.")).toBeDefined());
  await waitFor(() => expect(sidebar().getByText("make me a simple server")).toBeDefined());
  return { center, threadRow };
}

/** Resolves once the frame being drawn has painted: a frame callback runs before the paint, a task queued from it after. */
const painted = () => act(() => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve))));

/** Steps n frames of the fake clock, 16 ms each, running the promise callbacks each frame's work queued as a
 * browser does between tasks. */
const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await act(() => vi.advanceTimersByTimeAsync(16));
};

/** The composer's editor, focused with its caret at the end of the draft, and a count of the commits it makes from now. */
async function focusedComposer() {
  const element = composerEditor();
  clickIntoEditor(element);
  await act(async () => await new Promise(r => setTimeout(r, 20)));
  const editor = (element as unknown as { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  const commits = { n: 0 };
  editor.registerUpdateListener(() => commits.n++);
  return { element, commits };
}

describe("a thread switch", () => {
  it("keeps the transcript it leaves mounted, hidden and inert, until the next one has painted", async () => {
    const { center, threadRow } = await mount();
    const left = center().getByText("Checking the keychain.");
    fireEvent.click(threadRow("make me a simple server"));
    expect(center().getByText("Added GET /health.").closest("[inert]")).toBeNull();
    expect(left.isConnected).toBe(true);
    expect(left.closest("[inert]")?.getAttribute("aria-hidden")).toBe("true");
    await painted();
    expect(left.isConnected).toBe(false);
    expect(center().queryByText("Checking the keychain.")).toBeNull();
  });

  it("from a tile leaves a composer it does not change untouched", async () => {
    const { center, threadRow } = await mount();
    const { element, commits } = await focusedComposer();
    fireEvent.click(threadRow("make me a simple server"));
    await painted();
    expect(center().getByText("Added GET /health.")).toBeDefined();
    expect(commits.n).toBe(0);
    expect(document.activeElement).toBe(element);
  });

  it("from a chord that asks for the composer's focus makes no editor update when the caret already stands there", async () => {
    const { center } = await mount();
    const { element, commits } = await focusedComposer();
    act(() => goToWorkspace(WS, "thr_a"));
    await painted();
    expect(center().getByText("Added GET /health.")).toBeDefined();
    expect(commits.n).toBe(0);
    expect(document.activeElement).toBe(element);
  });

  it("from a chord still puts the caret in a composer that did not hold it", async () => {
    const { center } = await mount();
    const { element } = await focusedComposer();
    element.blur();
    act(() => goToWorkspace(WS, "thr_a"));
    await painted();
    expect(center().getByText("Added GET /health.")).toBeDefined();
    expect(document.activeElement).toBe(element);
    const selection = window.getSelection();
    expect(selection !== null && selection.anchorNode !== null && element.contains(selection.anchorNode)).toBe(true);
  });

  it("shows the next thread's rows within a few frames, not after a fixed wait for its scroll to settle", async () => {
    const restoreScroller = installFakeScroller();
    try {
      const { center, threadRow } = await mount();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
      fireEvent.click(threadRow("make me a simple server"));
      // The list holds its rows at opacity 0 until its opening scroll to the end has finished.
      const shown = () => {
        let node: HTMLElement | null = center().getByText("Added GET /health.");
        while (node !== null && node.style.opacity === "") node = node.parentElement;
        return node?.style.opacity;
      };
      // Three frames are 48 ms of the fake clock, short of the 100 ms the unpatched list waits.
      for (let frame = 0; frame < 3 && shown() !== "1"; frame++) await frames(1);
      expect(shown()).toBe("1");
    } finally {
      restoreScroller();
    }
  });

  // 4 frames is a chunk every 64 ms, inside the 100 ms the unpatched list's opening scroll takes; 16 frames is 256 ms.
  it.each([4, 16])("follows a turn the host starts while the opened thread's scroll to its end is still held, a chunk every %i frames", async gap => {
    const restoreScroller = installFakeScroller();
    // The streamed reply's row grows by 40 px a chunk, as a reply does while its text arrives.
    const proto = HTMLElement.prototype;
    const fixed = { rect: proto.getBoundingClientRect, height: Object.getOwnPropertyDescriptor(proto, "offsetHeight")! };
    const growth = (el: HTMLElement) => (el.style.position === "absolute" ? (el.textContent?.match(/chunk/g)?.length ?? 0) * 40 : 0);
    proto.getBoundingClientRect = function (this: HTMLElement) {
      const rect = fixed.rect.call(this);
      return { ...rect, height: rect.height + growth(this), bottom: rect.bottom + growth(this) };
    };
    Object.defineProperty(proto, "offsetHeight", { configurable: true, get(this: HTMLElement) { return (fixed.height.get!.call(this) as number) + growth(this); } });
    try {
      const { center, threadRow } = await mount();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
      fireEvent.click(threadRow("make me a simple server"));
      await frames(20);
      // A turn this window did not send (a queued message, a woken lead, a send from a shell) starts inside the 2 s
      // the list keeps its opening scroll's target.
      const C = { workspaceId: WS, sessionId: "sess_c", turnId: "turn_c", threadId: "thr_a" };
      const at = T0 + 120_000;
      let pos = TRANSCRIPT.length;
      push({ type: "session.start", ...C, at, prompt: "a turn from the host", pos: ++pos });
      for (let chunk = 1; chunk <= 12; chunk++) {
        push({ type: "session.delta", ...C, at: at + chunk, kind: "text", text: chunk === 12 ? " the last chunk." : ` chunk ${chunk}`, pos: ++pos });
        await frames(gap);
      }
      await frames(40);
      const last = center().getByText(/the last chunk\./);
      const viewport = last.closest<HTMLElement>(".overscroll-y-contain")!;
      const row = last.closest<HTMLElement>("[style*='position: absolute']")!;
      // The last chunk ends the reply, so the row's bottom edge is where it shows.
      const bottom = parseFloat(row.style.top) + row.offsetHeight;
      expect(bottom).toBeGreaterThan(viewport.scrollTop);
      expect(bottom).toBeLessThanOrEqual(viewport.scrollTop + viewport.clientHeight);
    } finally {
      proto.getBoundingClientRect = fixed.rect;
      Object.defineProperty(proto, "offsetHeight", fixed.height);
      restoreScroller();
    }
  });

  it("leaves the shared list handle with the list shown when the list it replaced lets go", async () => {
    const listRef = createRef<LegendListRef | null>();
    const at = "2026-10-07T08:00:00.000Z";
    const timeline = (key: string) => (
      <MessagesTimeline
        key={key}
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={listRef}
        timelineEntries={[{ id: `m_${key}`, kind: "message", createdAt: at, message: { id: `m_${key}`, role: "user", text: `asked in ${key}`, turnId: null, createdAt: at, updatedAt: at, streaming: false } }]}
        turns={[]}
        threadKey={key}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    );
    const view = render(<div style={{ height: 600 }}>{[timeline("a")]}</div>);
    await painted();
    const left = listRef.current;
    view.rerender(<div style={{ height: 600 }}>{[timeline("a"), timeline("b")]}</div>);
    await painted();
    const shown = listRef.current;
    expect(shown).not.toBeNull();
    expect(shown).not.toBe(left);
    view.rerender(<div style={{ height: 600 }}>{[timeline("b")]}</div>);
    expect(listRef.current).toBe(shown);
  });
});

