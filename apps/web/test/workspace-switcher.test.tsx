// SPDX-License-Identifier: AGPL-3.0-only
// The hold-to-switch overlay: ctrl+tab with the key still down puts it up,
// tab and shift+tab walk it, letting the key go opens the highlighted
// thread, Escape and a lost window leave everything where it was, and a tap
// is a walk of one followed by a release, which paints nothing. The cards are
// the threads the sidebar lists, Settled left out, most recently opened
// first with the open one at the head, at most six in one row; each carries
// the picture well, holding the project's glyph until a picture lands, the
// thread's title and its line in the sans. The thread chord walks the same
// overlay over the threads of the workspace on screen.
import { act, cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type PlaceView, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { deriveSidebarProjects } from "../src/adapt/index.js";
import { buildPaletteItems } from "../src/components/palette/paletteItems.js";
import { buildSwitcherCards } from "../src/components/switcher/switcherCards.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { ROW_META_CLASS } from "../src/sidebar/rowGrammar.js";
import { AppShell } from "../src/shell/AppShell.js";
import { onComposerFocusRequest } from "../src/shell/shellRequests.js";
import { loadPagePreviews, useWorkspacePreviews } from "../src/shell/workspacePreviews.js";
import { recentThreads, SWITCHER_THREADS, useThreadHistory } from "../src/shell/threadHistory.js";
import { releasesSwitchHold, stepSwitcherAt, SWITCHER_PAINT_DELAY_MS, useWorkspaceSwitcher } from "../src/shell/workspaceSwitcher.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices } from "./notice-text.js";

const CAPS = caps();

const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running", createdAt = "2026-09-01T00:00:00Z"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase,
  golden: "snap_g",
  createdAt,
});

const session = (id: string, workspaceId: string, prompt: string, startedAt: number): SessionView => ({
  id,
  workspaceId,
  harness: "claude",
  status: "completed",
  prompt,
  startedBy: "person",
  startedAt,
  endedAt: startedAt + 60_000,
});
/** A thread the runtime stamped an id on, which is what a card lands on. */
const thread = (threadId: string, workspaceId: string, prompt: string, minutesAgo: number): SessionView => ({ ...session(`s_${threadId}`, workspaceId, prompt, Date.now() - minutesAgo * 60_000), threadId });

const WORKSPACES = [view("ws_a", "api", "running", "2026-09-01T01:00:00Z"), view("ws_b", "web", "running", "2026-09-01T02:00:00Z"), view("ws_c", "old", "napping", "2026-09-01T03:00:00Z")];
const SESSIONS = [thread("t_a", "ws_a", "Fix the login redirect.", 10), thread("t_b", "ws_b", "Bump the lockfile and run the gate.", 20), thread("t_c", "ws_c", "Write the release notes.", 30)];

function fakeApi(sessions: SessionView[] = SESSIONS): Api {
  return {
    listWorkspaces: async () => WORKSPACES,
    getWorkspace: async id => WORKSPACES.find(w => w.id === id)!,
    createWorkspace: async () => WORKSPACES[0]!,
    watchStatuses: async () => [],
    forget: async () => {},
    nap: async id => WORKSPACES.find(w => w.id === id)!,
    wake: async id => WORKSPACES.find(w => w.id === id)!,
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s9", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => sessions,
    subscribe: () => () => {},
    getGolden: async () => undefined,
  };
}

const tab = (mods: { shiftKey?: boolean } = {}) => fireEvent.keyDown(window, { key: "Tab", code: "Tab", ctrlKey: true, ...mods });
/** The switch as the mod arrows spell it on macOS; the platform is mocked to MacIntel for the file. */
const spaceArrow = (name: "ArrowLeft" | "ArrowRight") => fireEvent.keyDown(window, { key: name, code: name, metaKey: true, altKey: true });
const release = () => fireEvent.keyUp(window, { key: "Control" });
const releaseSpaceArrow = () => fireEvent.keyUp(window, { key: "Alt" });
const escape = () => fireEvent.keyDown(window, { key: "Escape", code: "Escape" });

/** The desktop shell, told apart by the bridge its preload puts on the page. */
const asDesktopShell = (bridge: Partial<Window["wsp"]> = {}): (() => void) => {
  window.wsp = bridge;
  return () => delete window.wsp;
};

const overlay = () => document.querySelector<HTMLElement>("[data-workspace-switcher]");
const cardIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-thread-card]")].map(el => el.dataset["threadCard"]!);
const highlightedCard = (): string | null => document.querySelector<HTMLElement>("[data-thread-card][aria-selected=true]")?.dataset["threadCard"] ?? null;
const card = (threadId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-thread-card='${threadId}']`);
const cardPart = (threadId: string, part: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-thread-card='${threadId}'] [data-card-${part}]`);
/** The parts a card is built of, in the order it draws them; a child that is no named part reads as "?". */
const cardParts = (threadId: string): string[] =>
  [...(card(threadId)?.children ?? [])].map(el => el.getAttributeNames().find(name => name.startsWith("data-card-"))?.slice("data-card-".length) ?? "?");
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
const opened = () => ({ workspaceId: useStore.getState().selectedId, threadId: useStore.getState().selectedThreadId });

vi.setConfig({ testTimeout: 15_000 });
configure({ asyncUtilTimeout: 10_000 });

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true } });
  clearNotices();
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
  useWorkspacePreviews.setState({ images: {} });
  useThreadHistory.setState({ recent: [] });
  useWorkspaceSwitcher.getState().close();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const visit = (workspaceId: string, threadId: string): void => {
  act(() => useStore.getState().select(workspaceId, threadId));
};

/** The shell over the three threads, opened oldest first so the last opened is t_a, the one on screen. */
async function mountShell(sessions: SessionView[] = SESSIONS): Promise<void> {
  useStore.getState().bind(fakeApi(sessions));
  render(
    <AppShell>
      <div>center content</div>
    </AppShell>,
  );
  await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
  await waitFor(() => expect(Object.values(useStore.getState().sessions).flat()).toHaveLength(sessions.length));
  for (const at of [...sessions].reverse()) if (at.threadId !== undefined) visit(at.workspaceId, at.threadId);
}

/** The caret asks for one workspace from this call on; one left pending by an earlier test is dropped. */
const watchComposerFocus = (workspaceId: string): { asks: string[]; off: () => void } => {
  const asks: string[] = [];
  const off = onComposerFocusRequest(workspaceId, () => asks.push(workspaceId));
  asks.length = 0;
  return { asks, off };
};

describe("the workspace switcher overlay", () => {
  it("goes up on ctrl+tab while the key is held, one card per thread most recently opened first, the open one first and the one before it highlighted, and selects nothing yet", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      expect(opened()).toEqual({ workspaceId: "ws_a", threadId: "t_a" });
      expect(overlay()).toBeNull();
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(cardIds()).toEqual(["t_a", "t_b", "t_c"]);
      expect(highlightedCard()).toBe("t_b");
      expect(opened()).toEqual({ workspaceId: "ws_a", threadId: "t_a" });
    } finally {
      restore();
    }
  });

  it("orders by when each thread was last opened, not by the sidebar's order, so a hold walks back in time", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      visit("ws_c", "t_c");
      visit("ws_b", "t_b");
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(cardIds()).toEqual(["t_b", "t_c", "t_a"]);
      expect(highlightedCard()).toBe("t_c");
    } finally {
      restore();
    }
  });

  it("holds its paint back, so the state opens at once and the overlay only draws once the chord is really held", async () => {
    await mountShell();
    const restore = asDesktopShell();
    vi.useFakeTimers();
    try {
      act(() => {
        tab();
      });
      expect(useWorkspaceSwitcher.getState().open).toBe(true);
      expect(overlay()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(SWITCHER_PAINT_DELAY_MS - 1);
      });
      expect(overlay()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(overlay()).not.toBeNull();
      expect(highlightedCard()).toBe("t_b");
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it("a tap that lets the hold go inside the delay never dims the app, and still switches", async () => {
    await mountShell();
    const restore = asDesktopShell();
    vi.useFakeTimers();
    try {
      // Each act flushes the render the step caused, so the paint timer is really running when the hold comes up.
      act(() => {
        tab();
      });
      act(() => {
        vi.advanceTimersByTime(SWITCHER_PAINT_DELAY_MS - 1);
      });
      expect(overlay()).toBeNull();
      act(() => {
        release();
      });
      expect(opened()).toEqual({ workspaceId: "ws_b", threadId: "t_b" });
      act(() => {
        vi.advanceTimersByTime(SWITCHER_PAINT_DELAY_MS * 4);
      });
      expect(overlay()).toBeNull();
      expect(document.querySelector(".dialog-backdrop")).toBeNull();
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it("a second step inside the delay does not push the paint further out", async () => {
    await mountShell();
    const restore = asDesktopShell();
    vi.useFakeTimers();
    try {
      act(() => {
        tab();
      });
      act(() => {
        vi.advanceTimersByTime(SWITCHER_PAINT_DELAY_MS - 20);
      });
      act(() => {
        tab();
      });
      expect(useWorkspaceSwitcher.getState().at).toBe(2);
      expect(overlay()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(20);
      });
      expect(overlay()).not.toBeNull();
      expect(highlightedCard()).toBe("t_c");
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it("walks forward on tab and back on shift+tab, wrapping at both ends over an order that does not move", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab();
      await waitFor(() => expect(highlightedCard()).toBe("t_b"));
      tab();
      await waitFor(() => expect(highlightedCard()).toBe("t_c"));
      tab();
      await waitFor(() => expect(highlightedCard()).toBe("t_a"));
      tab({ shiftKey: true });
      await waitFor(() => expect(highlightedCard()).toBe("t_c"));
      expect(cardIds()).toEqual(["t_a", "t_b", "t_c"]);
      expect(opened()).toEqual({ workspaceId: "ws_a", threadId: "t_a" });
    } finally {
      restore();
    }
  });

  it("commits on the hold being let go: the highlighted thread opens in its workspace and its composer is asked for the caret", async () => {
    await mountShell();
    const restore = asDesktopShell();
    const { asks, off } = watchComposerFocus("ws_c");
    try {
      tab();
      tab();
      await waitFor(() => expect(highlightedCard()).toBe("t_c"));
      release();
      await waitFor(() => expect(opened()).toEqual({ workspaceId: "ws_c", threadId: "t_c" }));
      expect(overlay()).toBeNull();
      expect(asks).toEqual(["ws_c"]);
    } finally {
      off();
      restore();
    }
  });

  it("a tap is one step and a release, so it still switches at once, and a second tap comes back", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab();
      release();
      await waitFor(() => expect(opened()).toEqual({ workspaceId: "ws_b", threadId: "t_b" }));
      expect(overlay()).toBeNull();
      tab();
      release();
      await waitFor(() => expect(opened()).toEqual({ workspaceId: "ws_a", threadId: "t_a" }));
    } finally {
      restore();
    }
  });

  it("cancels on Escape, and the release that follows moves nothing", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab();
      tab();
      await waitFor(() => expect(highlightedCard()).toBe("t_c"));
      escape();
      await waitFor(() => expect(overlay()).toBeNull());
      expect(opened()).toEqual({ workspaceId: "ws_a", threadId: "t_a" });
      release();
      await settle();
      expect(opened()).toEqual({ workspaceId: "ws_a", threadId: "t_a" });
    } finally {
      restore();
    }
  });

  it("leaves when the window does, since a hold let go elsewhere never comes back here", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      fireEvent.blur(window);
      await waitFor(() => expect(overlay()).toBeNull());
      expect(opened()).toEqual({ workspaceId: "ws_a", threadId: "t_a" });
    } finally {
      restore();
    }
  });

  it("in a browser tab the chord is the browser's, so no overlay goes up", async () => {
    await mountShell();
    tab();
    await settle();
    expect(overlay()).toBeNull();
    expect(opened()).toEqual({ workspaceId: "ws_a", threadId: "t_a" });
  });

  it("draws at most six cards, the six opened last, every one the same box", async () => {
    const many = Array.from({ length: 12 }, (_, n) => thread(`t_${n}`, WORKSPACES[n % 3]!.id, `Thread ${n}.`, n + 1));
    await mountShell(many);
    const restore = asDesktopShell();
    try {
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(SWITCHER_THREADS).toBe(6);
      expect(cardIds()).toEqual(many.slice(0, 6).map(at => at.threadId));
      expect(new Set(cardIds().map(id => card(id)!.className.replace("bg-foreground/[0.09]", "").trim())).size).toBe(1);
    } finally {
      restore();
    }
  });

  it("leaves out the threads the sidebar folds into Settled, however recently they were opened", async () => {
    const done = { ...thread("t_done", "ws_b", "An old settled thread.", 60), readAt: Date.now() - 50 * 60_000, settledAt: Date.now() - 40 * 60_000 };
    await mountShell([...SESSIONS, done]);
    const restore = asDesktopShell();
    try {
      visit("ws_b", "t_done");
      visit("ws_a", "t_a");
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(cardIds()).toEqual(["t_a", "t_b", "t_c"]);
    } finally {
      restore();
    }
  });

  it("carries the thread's title and under it a sans line in the muted ink, the same three parts on every card, and no cost", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      // A cost is ticking for this workspace while the overlay is up, and it reaches no card.
      act(() => {
        useStore.setState({ costs: { ws_b: { rateUsdPerHour: 0.35, accruedUsd: 1.2345, at: "2026-09-07T10:00:00Z" } } });
      });
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(cardPart("t_b", "name")?.textContent).toBe("Bump the lockfile and run the gate.");
      const line = cardPart("t_b", "thread")!;
      expect(line.className).toContain("text-muted-foreground");
      expect(line.className).not.toContain(ROW_META_CLASS);
      expect(line.outerHTML).not.toContain("font-mono");
      expect(line.textContent).not.toMatch(/\$|1\.23|this Mac|\u2014/);
      for (const id of ["t_a", "t_b", "t_c"]) expect(cardParts(id)).toEqual(["preview", "name", "thread"]);
      // One box for every card; the highlight is a fill and nothing else.
      expect(new Set(cardIds().map(id => card(id)!.className.replace("bg-foreground/[0.09]", "").trim())).size).toBe(1);
      expect(new Set(cardIds().map(id => cardPart(id, "preview")!.className)).size).toBe(1);
    } finally {
      restore();
    }
  });

  it("holds the project's glyph in its hue in a well with no picture, never a line saying there is none", async () => {
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, projectLook: { pr_1: { icon: "rocket", hue: "violet" } } } });
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab();
      await waitFor(() => expect(overlay()).not.toBeNull());
      const well = cardPart("t_b", "preview")!;
      expect(well.textContent).toBe("");
      const glyph = well.querySelector("svg")!;
      expect(glyph.getAttribute("data-hue")).toBe("violet");
      expect(glyph.getAttribute("class")).toContain("text-violet-500");
      expect(glyph.getAttribute("class")).toContain("lucide-rocket");
      expect(document.body.textContent).not.toContain("No capture yet");
    } finally {
      restore();
    }
  });

  it("draws the thread's picture where the shell holds one, and asks it to photograph the thread being left", async () => {
    await mountShell();
    const capturePreview = vi.fn(async () => undefined);
    const workspacePreview = vi.fn(async (id: string) => (id === "t_b" ? "data:image/png;base64,AAA" : undefined));
    const restore = asDesktopShell({ capturePreview, workspacePreview });
    try {
      tab();
      await waitFor(() => expect(card("t_b")?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAA"));
      expect(cardPart("t_a", "preview")?.querySelector("svg")).not.toBeNull();
      expect(cardParts("t_b")).toEqual(["preview", "name", "thread"]);
      release();
      await waitFor(() => expect(opened()).toEqual({ workspaceId: "ws_b", threadId: "t_b" }));
      expect(capturePreview).toHaveBeenCalledWith("t_a");
    } finally {
      restore();
    }
  });
});

describe("loadPagePreviews", () => {
  it("keeps what the shell still answers for and drops what it has let go at its own cap", async () => {
    useWorkspacePreviews.setState({ images: { t_a: "data:image/png;base64,OLD" } });
    const restore = asDesktopShell({ workspacePreview: async id => (id === "t_b" ? "data:image/png;base64,NEW" : undefined) });
    try {
      await loadPagePreviews(["t_a", "t_b"]);
      expect(useWorkspacePreviews.getState().images).toEqual({ t_b: "data:image/png;base64,NEW" });
    } finally {
      restore();
    }
  });

  it("touches nothing where the shell cannot answer at all", async () => {
    useWorkspacePreviews.setState({ images: { t_a: "data:image/png;base64,OLD" } });
    await loadPagePreviews(["t_a", "t_b"]);
    expect(useWorkspacePreviews.getState().images).toEqual({ t_a: "data:image/png;base64,OLD" });
  });
});

describe("the card the space arrows put up", () => {
  it("is the same card, and it ends on the option coming up rather than on the key the other chord holds", async () => {
    await mountShell();
    const restore = asDesktopShell();
    const { asks, off } = watchComposerFocus("ws_b");
    try {
      spaceArrow("ArrowRight");
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(cardIds()).toEqual(["t_a", "t_b", "t_c"]);
      expect(highlightedCard()).toBe("t_b");
      // The other switch chord's own hold is not this walk's, so letting it go leaves the card up.
      release();
      await settle();
      expect(useWorkspaceSwitcher.getState().open).toBe(true);
      releaseSpaceArrow();
      await waitFor(() => expect(opened()).toEqual({ workspaceId: "ws_b", threadId: "t_b" }));
      expect(overlay()).toBeNull();
      expect(asks).toEqual(["ws_b"]);
    } finally {
      off();
      restore();
    }
  });

  it("walks back on the left arrow, and puts nothing up in a browser tab, which keeps that chord and the Tab pair", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      spaceArrow("ArrowLeft");
      await waitFor(() => expect(highlightedCard()).toBe("t_c"));
      releaseSpaceArrow();
      await waitFor(() => expect(opened()).toEqual({ workspaceId: "ws_c", threadId: "t_c" }));
    } finally {
      restore();
    }
    spaceArrow("ArrowLeft");
    tab();
    await settle();
    expect(useWorkspaceSwitcher.getState().open).toBe(false);
    expect(opened()).toEqual({ workspaceId: "ws_c", threadId: "t_c" });
  });

  it("keeps Shift for the step back, so letting Shift go mid-walk commits nothing", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      tab({ shiftKey: true });
      await waitFor(() => expect(highlightedCard()).toBe("t_c"));
      fireEvent.keyUp(window, { key: "Shift" });
      await settle();
      expect(useWorkspaceSwitcher.getState().open).toBe(true);
      expect(opened()).toEqual({ workspaceId: "ws_a", threadId: "t_a" });
      release();
      await waitFor(() => expect(opened()).toEqual({ workspaceId: "ws_c", threadId: "t_c" }));
    } finally {
      restore();
    }
  });
});

describe("the thread chord", () => {
  const SIX = [1, 2, 3, 4, 5, 6].map(n => thread(`thr_${n}`, "ws_a", `thread ${n}`, n));

  /** The walk as a person makes it: the mod arrows under the pair that walks the workspaces, held while the overlay
   * stands and landed on the hold coming up. Shift is no part of it here, since down and up are the two ways. */
  /** The hold of that chord let go, which is what commits the walk: Alt, as the workspace arrows commit on. */
  const releaseThread = (): void => {
    fireEvent.keyUp(window, { key: "Alt" });
  };
  const threadStep = (mods: { shiftKey?: boolean } = {}): void => {
    fireEvent.keyDown(window, { key: mods.shiftKey === true ? "ArrowUp" : "ArrowDown", code: mods.shiftKey === true ? "ArrowUp" : "ArrowDown", metaKey: true, altKey: true });
  };

  async function mountThreads(threads: SessionView[]): Promise<() => void> {
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true } });
    useThreadHistory.setState({ recent: [] });
    useStore.getState().bind({ ...fakeApi(), listSessions: async () => threads });
    render(
      <AppShell>
        <div>center content</div>
      </AppShell>,
    );
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
    await waitFor(() => expect(Object.values(useStore.getState().sessions).flat()).toHaveLength(threads.length));
    return asDesktopShell();
  }
  const visit = (threadId: string): void => {
    act(() => useStore.getState().select("ws_a", threadId));
  };
  const threadCards = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-thread-card]")].map(el => el.dataset["threadCard"]!);
  const highlightedThread = (): string | null => document.querySelector<HTMLElement>("[data-thread-card][aria-selected=true]")?.dataset["threadCard"] ?? null;

  it("held, the walk puts up the threads of the workspace on screen, the open one first and the one before it highlighted; the arrows walk on and letting go lands there", async () => {
    const restore = await mountThreads([...SIX, thread("thr_web", "ws_b", "A thread on another workspace.", 0)]);
    try {
      act(() => useStore.getState().select("ws_b", "thr_web"));
      for (const id of ["thr_6", "thr_5", "thr_4", "thr_3", "thr_2", "thr_1"]) visit(id);
      threadStep();
      await waitFor(() => expect(overlay()).not.toBeNull());
      // The workspace's six, most recent first, the other workspace's thread left to the switch chord.
      expect(threadCards()).toEqual(["thr_1", "thr_2", "thr_3", "thr_4", "thr_5", "thr_6"]);
      expect(document.querySelectorAll("[data-card-preview]")).toHaveLength(6);
      expect(highlightedThread()).toBe("thr_2");
      expect(document.querySelector("[data-thread-card='thr_2'] [data-card-name]")?.textContent).toBe("thread 2");
      // Under the title the agent's mark, the computer by its name and the one status slot, nothing joined.
      const second = document.querySelector("[data-thread-card='thr_2'] [data-card-thread]")!;
      expect(second.querySelector("[data-harness-mark='claude']")).not.toBeNull();
      expect(second.querySelector("[data-thread-status]")).not.toBeNull();
      expect(second.textContent).not.toMatch(/,|·|Claude Code/);
      // Nothing moves until the hold is let go.
      expect(useStore.getState().selectedThreadId).toBe("thr_1");
      threadStep();
      await waitFor(() => expect(highlightedThread()).toBe("thr_3"));
      threadStep({ shiftKey: true });
      await waitFor(() => expect(highlightedThread()).toBe("thr_2"));
      threadStep();
      threadStep();
      await waitFor(() => expect(highlightedThread()).toBe("thr_4"));
      releaseThread();
      await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("thr_4"));
      expect(useStore.getState().selectedId).toBe("ws_a");
      expect(overlay()).toBeNull();
    } finally {
      restore();
    }
  });

  it("a tap switches to the thread before this one, and a second tap comes back, without the overlay ever painting", async () => {
    const restore = await mountThreads(SIX);
    vi.useFakeTimers();
    try {
      visit("thr_3");
      visit("thr_5");
      act(() => {
        threadStep();
      });
      act(() => {
        releaseThread();
      });
      expect(useStore.getState().selectedThreadId).toBe("thr_3");
      act(() => {
        vi.advanceTimersByTime(SWITCHER_PAINT_DELAY_MS * 2);
      });
      expect(overlay()).toBeNull();
      act(() => {
        threadStep();
      });
      act(() => {
        releaseThread();
      });
      expect(useStore.getState().selectedThreadId).toBe("thr_5");
      // Shift and a tap is the far end of the six.
      act(() => {
        threadStep({ shiftKey: true });
      });
      act(() => {
        releaseThread();
      });
      expect(useStore.getState().selectedThreadId).not.toBe("thr_5");
      expect(useStore.getState().selectedThreadId).not.toBe("thr_3");
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it("with no thread open, as right after a workspace switch, a tap lands on the most recently opened thread and the hold starts there; Shift starts at the far end", async () => {
    const restore = await mountThreads(SIX);
    try {
      visit("thr_3");
      visit("thr_5");
      // The workspace alone, the way goToWorkspace leaves it after a switch between workspaces.
      act(() => useStore.getState().select("ws_a"));
      expect(useStore.getState().selectedThreadId).toBeNull();
      threadStep();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(threadCards()).toEqual(["thr_5", "thr_3", "thr_1", "thr_2", "thr_4", "thr_6"]);
      expect(highlightedThread()).toBe("thr_5");
      releaseThread();
      await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("thr_5"));
      act(() => useStore.getState().select("ws_a"));
      threadStep({ shiftKey: true });
      releaseThread();
      await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("thr_6"));
    } finally {
      restore();
    }
  });

  it("threads never opened follow the ones that were, in the sidebar's order, and one thread alone puts nothing up", async () => {
    const restore = await mountThreads(SIX.slice(0, 3));
    try {
      visit("thr_2");
      threadStep();
      await waitFor(() => expect(overlay()).not.toBeNull());
      expect(threadCards()).toEqual(["thr_2", "thr_1", "thr_3"]);
      escape();
      await waitFor(() => expect(overlay()).toBeNull());
      expect(recentThreads([], [], null)).toEqual([]);
    } finally {
      restore();
    }
    cleanup();
    const alone = await mountThreads(SIX.slice(0, 1));
    try {
      visit("thr_1");
      threadStep();
      await settle();
      expect(useWorkspaceSwitcher.getState().open).toBe(false);
      expect(useStore.getState().selectedThreadId).toBe("thr_1");
    } finally {
      alone();
    }
  });
});

describe("stepSwitcherAt", () => {
  it("wraps at both ends and always moves, since the key has to answer once the overlay is up", () => {
    expect(stepSwitcherAt(3, 0, 1)).toBe(1);
    expect(stepSwitcherAt(3, 2, 1)).toBe(0);
    expect(stepSwitcherAt(3, 0, -1)).toBe(2);
    expect(stepSwitcherAt(1, 0, 1)).toBe(0);
    expect(stepSwitcherAt(0, 0, 1)).toBe(0);
  });
});

describe("releasesSwitchHold", () => {
  it("ends the walk on a key the chord that opened it was holding, and on nothing else", () => {
    expect(releasesSwitchHold({ open: true, hold: ["Control"] }, "Control")).toBe(true);
    expect(releasesSwitchHold({ open: true, hold: ["Alt"] }, "Alt")).toBe(true);
    expect(releasesSwitchHold({ open: true, hold: ["Control"] }, "Alt")).toBe(false);
    expect(releasesSwitchHold({ open: true, hold: ["Control"] }, "Shift")).toBe(false);
    expect(releasesSwitchHold({ open: false, hold: ["Control"] }, "Control")).toBe(false);
  });
});

describe("buildSwitcherCards", () => {
  const projects = deriveSidebarProjects({ workspaces: WORKSPACES, sessions: { ws_a: [SESSIONS[0]!], ws_b: [SESSIONS[1]!], ws_c: [SESSIONS[2]!] } });

  it("keeps the order it is given, drops a thread the snapshot no longer holds, and carries its parts alone", () => {
    const targets = [{ workspaceId: "ws_c", threadId: "t_c" }, { workspaceId: "ws_b", threadId: "t_gone" }, { workspaceId: "ws_gone", threadId: "t_b" }, { workspaceId: "ws_a", threadId: "t_a" }];
    const cards = buildSwitcherCards({ places: [], projects, targets, images: { t_a: "data:image/png;base64,AAA" } });
    expect(cards.map(c => c.threadId)).toEqual(["t_c", "t_a"]);
    expect(Object.keys(cards[0]!)).toEqual(["workspaceId", "threadId", "name", "thread", "place", "projectId", "image"]);
    expect(cards.map(c => [c.projectId, c.image])).toEqual([["pr_1", null], ["pr_1", "data:image/png;base64,AAA"]]);
  });

  it("says where a thread on this computer runs only once the name is known, never leaving a line on a dangling on", () => {
    const here = { ...view("ws_a", "api"), kind: "local" as const, machineId: "local" };
    const lead = { ...session("s_lead", "ws_a", "The lead.", Date.parse("2026-09-01T01:00:00Z")), threadId: "thr_lead" };
    const child = { ...session("s_kid", "ws_a", "The child.", Date.parse("2026-09-01T02:00:00Z")), threadId: "thr_kid", parentThreadId: "thr_lead", startedBy: "agent" as const };
    const projects = deriveSidebarProjects({ workspaces: [here], sessions: { ws_a: [lead, child] } });
    const MAC: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", default: true };
    const palette = (places: PlaceView[]) => buildPaletteItems({ projects, selectedId: null, query: "", messageHits: [], canCreate: false, handlers: {} as never, verbs: {} as never, places });
    const card = (places: PlaceView[]) => buildSwitcherCards({ places, projects, targets: [{ workspaceId: "ws_a", threadId: "thr_kid" }], images: {} })[0]!.place;
    const said = (node: ReactNode): HTMLElement => render(<>{node}</>).container;
    for (const item of [...palette([]).workspaceItems, ...palette([]).recentThreadItems]) expect(said(item.description).textContent).not.toMatch(/ on\s*$|this computer/);
    expect(card([])).toBe("");
    // The workspace and the computer are two facts a gap apart, each its own span, never a sentence joining them.
    const facts = said(palette([MAC]).recentThreadItems.find(item => item.title === "The child.")!.description);
    expect([...facts.querySelectorAll("[data-fact]")].map(fact => fact.textContent)).toEqual(["api", "zingzy's MacBook Pro"]);
    expect(card([MAC])).toBe("zingzy's MacBook Pro");
  });

  it("offers Copy as Markdown for the thread on screen, and nothing where no thread is open", async () => {
    const copyThreadMarkdown = vi.fn(async () => {});
    const items = (copy: (() => Promise<void>) | null) =>
      buildPaletteItems({ projects: [], selectedId: null, query: "", messageHits: [], canCreate: false, handlers: { copyThreadMarkdown: copy } as never, verbs: {} as never, places: [] }).actionItems;
    const copy = items(copyThreadMarkdown).find(item => item.title === "Copy as Markdown")!;
    expect(copy.disabled).not.toBe(true);
    await copy.run();
    expect(copyThreadMarkdown).toHaveBeenCalledTimes(1);
    expect(items(null).find(item => item.title === "Copy as Markdown")).toBeUndefined();
  });

  it("a thread in the palette wears the agent's mark and the one status slot, and a workspace no dot for its state", () => {
    const running = { ...session("s_run", "ws_a", "The running one.", Date.now() - 125_000), status: "running" as const, endedAt: undefined };
    const projects = deriveSidebarProjects({ workspaces: WORKSPACES, sessions: { ws_a: [running] } });
    const items = buildPaletteItems({ projects, selectedId: null, query: "", messageHits: [], canCreate: false, handlers: {} as never, verbs: {} as never, places: [] });
    const item = items.recentThreadItems.find(found => found.title === "The running one.")!;
    expect(render(<>{item.icon}</>).container.querySelector("[data-harness-mark='claude']")).not.toBeNull();
    const slot = render(<>{item.titleTrailingContent}</>).container.querySelector<HTMLElement>("[data-thread-status]")!;
    expect(slot.dataset.threadStatus).toBe("working");
    expect(slot.className).toContain("w-22");
    for (const workspace of items.workspaceItems) expect(render(<>{workspace.icon}</>).container.querySelector(".rounded-full")).toBeNull();
  });

  it("a thread that has gone since the overlay froze leaves no card", () => {
    const at = { ...session("s_t", "ws_a", "The thread.", Date.parse("2026-09-01T02:00:00Z")), threadId: "thr_t", startedBy: "cli" as const };
    const snapshot = deriveSidebarProjects({ workspaces: WORKSPACES, sessions: { ws_a: [at] } });
    const cards = buildSwitcherCards({ places: [], projects: snapshot, targets: [{ workspaceId: "ws_a", threadId: "thr_t" }, { workspaceId: "ws_a", threadId: "thr_gone" }], images: {} });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ workspaceId: "ws_a", threadId: "thr_t", name: "The thread.", image: null });
    expect(cards[0]!.thread.threadId).toBe("thr_t");
  });
});
