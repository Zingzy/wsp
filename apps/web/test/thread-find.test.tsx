// SPDX-License-Identifier: AGPL-3.0-only
// Find in thread in the app: the keys through the real dispatcher, the bar over a thread drawn by ChatView, what a
// step opens, the count beside the highlights the page would paint, paging in, the cap's sentence, a thread switch
// and a turn streaming under the bar.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EventUnion, SessionEvent, WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { CLAUDE_THREAD, CLAUDE_WS, CODEX_THREAD, CODEX_WS, FIND_T0, claudeThread, codexThread } from "./fixtures/find-threads.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { ChatView } from "../src/components/chat/ChatView.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { KeybindingDispatcher } from "../src/shell/KeybindingDispatcher.js";
import { DEFAULT_KEYBINDINGS, DEFAULT_RESOLVED_KEYBINDINGS } from "../src/keybindingDefaults.js";
import { keybindingsFor } from "../src/keybindingOverrides.js";
import { resolveShortcutCommand } from "../src/keybindings.js";
import { keybindingCards } from "../src/settings/keybindings.js";
import { onComposerFocusAsked } from "../src/shell/shellRequests.js";
import { useThreadFind } from "../src/components/chat/find/store.js";
import { collectRanges, rangesIn } from "../src/components/chat/find/highlights.js";
import { needleOf, type Needle } from "../src/components/chat/find/match.js";
import { ThreadFind } from "../src/components/chat/find/ThreadFind.js";
import type { TimelineFinder } from "../src/components/chat/MessagesTimeline.js";
import { getSyntaxHighlighterPromise } from "../src/lib/syntaxHighlighting.js";
import { deriveSession } from "../src/adapt/index.js";
import { FIND_WORDS } from "../src/components/chat/find/words.js";
import type { RegexAsk } from "../src/components/chat/find/regex.js";

let restoreLayout: () => void = () => {};
beforeAll(async () => {
  restoreLayout = installFakeLayout();
  // jsdom scrolls nothing; the list scrolls a row into view with this.
  Element.prototype.scrollBy ??= () => {};
  await getSyntaxHighlighterPromise("ts");
});
afterAll(() => restoreLayout());
afterEach(() => {
  useThreadFind.setState({ open: false, query: "", matchCase: false, wholeWord: false, regex: false, tools: false, reveal: null });
  vi.unstubAllGlobals();
});

const view = (id: string): WorkspaceView => ({
  id,
  name: id,
  machineId: "m1",
  project: { id: `pr_${id}`, name: "lab", path: "/w", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

function fixtureApi(history: Record<string, SessionEvent[]>) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const workspaces = Object.keys(history).map(view);
  const api: Api = {
    portReach: async () => ({ url: "https://x.example", expiresAt: Date.now() + 3_600_000 }),
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
    capabilities: async () => caps(),
    listSessions: async () => [],
    watchStatuses: async () => [],
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getGolden: async () => undefined,
    startSession: async opts => ({ id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running" }),
  };
  const emit = (e: EventUnion) => act(() => {
    for (const fn of [...listeners]) fn(e);
  });
  return { api, emit };
}

function Shell({ workspaceId, threadId }: { workspaceId: string; threadId: string }) {
  return (
    <SidebarProvider>
      <KeybindingDispatcher keybindings={DEFAULT_RESOLVED_KEYBINDINGS} />
      <ChatView workspaceId={workspaceId} threadId={threadId}>
        {() => <textarea aria-label="composer" />}
      </ChatView>
    </SidebarProvider>
  );
}

async function open(workspaceId = CLAUDE_WS, threadId = CLAUDE_THREAD) {
  const fixture = fixtureApi({ [CLAUDE_WS]: claudeThread(), [CODEX_WS]: codexThread() });
  useStore.getState().bind(fixture.api);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBe(2));
  const shown = render(<Shell workspaceId={workspaceId} threadId={threadId} />);
  await screen.findAllByText(workspaceId === CLAUDE_WS ? /The newest replyword/ : /Nothing left/);
  return { ...fixture, shown };
}

const ctrl = (key: string, more: Partial<KeyboardEventInit> = {}) => ({ key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...more });
/** Ctrl+F where focus is; true when the app let the browser's own find have it. */
const pressFind = (): boolean => fireEvent.keyDown(document.activeElement ?? document.body, ctrl("f"));
const bar = () => screen.getByRole("search", { name: FIND_WORDS.field });
const field = () => within(bar()).getByRole("textbox") as HTMLInputElement;
const typeQuery = (query: string) => fireEvent.change(field(), { target: { value: query } });
const countSays = () => bar().querySelector("[data-find-count]")?.textContent ?? "";
const settled = async (words: string) => waitFor(() => expect(countSays()).toBe(words));

describe("find in thread: the keys", () => {
  it("Ctrl+F from the composer opens the bar focused and takes the key from the browser", async () => {
    await open();
    screen.getByLabelText("composer").focus();
    expect(pressFind()).toBe(false);
    expect(document.activeElement).toBe(field());
  });

  it("a selection in the transcript seeds the query; with none the last query shows selected; again focuses and selects", async () => {
    await open();
    const asked = await screen.findByText("And the last replyword?");
    window.getSelection()!.selectAllChildren(asked);
    pressFind();
    expect(field().value).toBe("And the last replyword?");
    fireEvent.keyDown(field(), { key: "Escape" });
    window.getSelection()!.removeAllRanges();
    screen.getByLabelText("composer").focus();
    pressFind();
    expect(field().value).toBe("And the last replyword?");
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, field().value.length]);
    field().setSelectionRange(3, 3);
    pressFind();
    expect(document.activeElement).toBe(field());
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, field().value.length]);
  });

  it("does nothing from a terminal or the right panel, and leaves Ctrl+F to the browser", async () => {
    await open();
    for (const mark of ["data-terminal-owner", "data-preview-panel-mode"]) {
      const host = document.createElement("div");
      host.setAttribute(mark, "drawer");
      const input = document.createElement("input");
      host.append(input);
      document.body.append(host);
      input.focus();
      expect(pressFind()).toBe(true);
      expect(screen.queryByRole("search")).toBeNull();
      host.remove();
    }
  });

  it("does nothing with no thread on screen", async () => {
    const { shown } = await open();
    shown.unmount();
    render(
      <SidebarProvider>
        <KeybindingDispatcher keybindings={DEFAULT_RESOLVED_KEYBINDINGS} />
      </SidebarProvider>,
    );
    expect(pressFind()).toBe(true);
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("names the three commands on Settings > Keybindings, which rebind, each behind its context key", () => {
    const cards = keybindingCards(DEFAULT_KEYBINDINGS, { platform: "Linux x86_64", desktopShell: false });
    const lines = cards.flatMap(card => card.items).filter(item => item.kind === "line");
    const said = (id: string) => lines.find(line => line.id === id);
    expect(said("thread.find")).toMatchObject({ label: "Find in thread", keys: [["Ctrl+F"]] });
    expect(said("thread.findOlder")).toMatchObject({ label: "Step to the older match", keys: [["Ctrl+G"], ["F3"]] });
    expect(said("thread.findNewer")).toMatchObject({ label: "Step to the newer match", keys: [["Ctrl+Shift+G"], ["Shift+F3"]] });
    const on = { platform: "Linux x86_64", context: { threadOpen: true, threadFindOpen: true } };
    expect(resolveShortcutCommand(ctrl("f"), DEFAULT_RESOLVED_KEYBINDINGS, on)).toBe("thread.find");
    expect(resolveShortcutCommand(ctrl("f"), DEFAULT_RESOLVED_KEYBINDINGS, { ...on, context: { threadOpen: false } })).toBeNull();
    expect(resolveShortcutCommand(ctrl("f"), DEFAULT_RESOLVED_KEYBINDINGS, { ...on, context: { threadOpen: true, terminalFocus: true } })).toBeNull();
    expect(resolveShortcutCommand({ key: "F3", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, DEFAULT_RESOLVED_KEYBINDINGS, on)).toBe("thread.findOlder");
    expect(resolveShortcutCommand(ctrl("g"), DEFAULT_RESOLVED_KEYBINDINGS, { ...on, context: { threadOpen: true, threadFindOpen: false } })).toBeNull();
    const rebound = keybindingsFor({ "thread.find": "mod+shift+u" });
    expect(resolveShortcutCommand(ctrl("u", { shiftKey: true }), rebound, on)).toBe("thread.find");
    expect(resolveShortcutCommand(ctrl("f"), rebound, on)).toBeNull();
  });
});

describe("find in thread: searching and stepping", () => {
  it("counts what people and agents said by default, and tool rows and Thinking with Include tool calls", async () => {
    await open();
    pressFind();
    typeQuery("descword");
    await settled(FIND_WORDS.noResults);
    fireEvent.click(within(bar()).getByRole("button", { name: FIND_WORDS.tools }));
    await settled("1 of 1");
    // A Thinking row opened shows its first line above its whole text, so that line counts twice.
    typeQuery("thinkword");
    await settled("3 of 3");
    typeQuery("hiddenword");
    await settled(FIND_WORDS.noResults);
  });

  it.each([
    ["a settled turn's fold", "commentword", () => screen.getByText("Looking at commentword now.")],
    ["a subagent fold", "subword", () => screen.getByText("subword found three callers")],
    ["a clamped long message", "longword", () => expect(screen.getByText(/names longword/).closest("[data-user-message-body]")?.getAttribute("data-user-message-collapsed")).toBe("false")],
    ["a collapsed run of tool calls", "pathword", () => screen.getByText(/src\/pathword\.ts/, { selector: "pre" })],
  ])("a match inside %s counts, and stepping to it opens what hides it", async (_hider, word, shown) => {
    await open();
    pressFind();
    if (word === "pathword") fireEvent.click(within(bar()).getByRole("button", { name: FIND_WORDS.tools }));
    typeQuery(word);
    await settled("1 of 1");
    // Typing paints where the match stands and opens nothing; the first step shows a match not in sight.
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(shown()).toBeTruthy());
    expect(countSays()).toBe("1 of 1");
    const ranges = collectRanges(document.body, needleOf(word, { matchCase: false, wholeWord: false, regex: false }) as Needle, word === "pathword");
    expect([...ranges.values()].flat().length).toBeGreaterThan(0);
  });

  it("steps older on Enter, the up chevron, Ctrl+G and F3 and newer on the rest, wrapping at both ends, from the newest", async () => {
    await open();
    pressFind();
    typeQuery("replyword");
    await settled("3 of 3");
    fireEvent.keyDown(field(), { key: "Enter" });
    await settled("2 of 3");
    fireEvent.click(within(bar()).getByRole("button", { name: FIND_WORDS.older }));
    await settled("1 of 3");
    fireEvent.keyDown(field(), ctrl("g"));
    await settled("3 of 3");
    fireEvent.keyDown(field(), { key: "F3" });
    await settled("2 of 3");
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    await settled("3 of 3");
    fireEvent.keyDown(field(), { key: "F3", shiftKey: true });
    await settled("1 of 3");
    fireEvent.keyDown(field(), ctrl("g", { shiftKey: true }));
    await settled("2 of 3");
    fireEvent.click(within(bar()).getByRole("button", { name: FIND_WORDS.newer }));
    await settled("3 of 3");
  });

  it("Escape closes the bar, clears the search and hands focus back to the composer", async () => {
    await open();
    const asked = vi.fn();
    const off = onComposerFocusAsked(CLAUDE_WS, asked);
    screen.getByLabelText("composer").focus();
    pressFind();
    typeQuery("replyword");
    await settled("3 of 3");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(useThreadFind.getState().reveal).toBeNull();
    expect(asked).toHaveBeenCalled();
    off();
  });

  it("keeps the query on a thread switch and searches the new thread from its newest match", async () => {
    const { shown } = await open();
    pressFind();
    typeQuery("reply");
    await settled("3 of 3");
    shown.rerender(<Shell workspaceId={CODEX_WS} threadId={CODEX_THREAD} />);
    await screen.findByText(/Nothing left/);
    expect(field().value).toBe("reply");
    await settled("2 of 2");
  });

  it("counts a match a streaming turn brings without moving the current one", async () => {
    const { emit } = await open();
    pressFind();
    typeQuery("replyword");
    await settled("3 of 3");
    fireEvent.keyDown(field(), { key: "Enter" });
    await settled("2 of 3");
    const scope = { workspaceId: CLAUDE_WS, threadId: CLAUDE_THREAD, sessionId: `sess_${CLAUDE_THREAD}`, turnId: `turn_${CLAUDE_THREAD}_4` };
    emit({ type: "session.start", ...scope, at: FIND_T0 + 4 * 600_000, model: "claude-opus-5-5", prompt: "One more replyword", cwd: "/w" } as SessionEvent);
    await settled("2 of 4");
  });

  it("toggles Match case, whole word and regex on Alt+C, W and R", async () => {
    await open();
    pressFind();
    const pressed = (name: string) => within(bar()).getByRole("button", { name }).hasAttribute("data-pressed");
    for (const [key, name] of [["c", FIND_WORDS.matchCase], ["w", FIND_WORDS.wholeWord], ["r", FIND_WORDS.regex]] as const) {
      expect(pressed(name)).toBe(false);
      fireEvent.keyDown(field(), { key, code: `Key${key.toUpperCase()}`, altKey: true });
      expect(pressed(name)).toBe(true);
    }
  });

  it("says a pattern that does not parse, and one that runs past the limit, without running it on the page", async () => {
    const asks: RegexAsk[] = [];
    // A worker that never answers, as one stuck on (a+)+$ does.
    class StuckWorker {
      onmessage = null;
      postMessage(ask: RegexAsk) {
        asks.push(ask);
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", StuckWorker);
    await open();
    pressFind();
    fireEvent.click(within(bar()).getByRole("button", { name: FIND_WORDS.regex }));
    typeQuery("(a");
    await waitFor(() => expect(bar().textContent).toContain(FIND_WORDS.invalid));
    typeQuery("(a+)+$");
    await waitFor(() => expect(bar().textContent).toContain(FIND_WORDS.slow), { timeout: 2000 });
    expect(asks.at(-1)?.query).toBe("(a+)+$");
  });
});

describe("find in thread: the count and the highlights", () => {
  const words = (word: string): Needle => needleOf(word, { matchCase: false, wholeWord: false, regex: false }) as Needle;

  it.each(["boldword", "linkword", "fenceword", "replyword", "insight", "session.ts", "auth", "L12", "store.ts"])("a markdown reply draws as many %s highlights as the count says", async word => {
    await open();
    pressFind();
    typeQuery(word);
    const total = Number(/of (\d+)/.exec(await waitFor(() => {
      expect(countSays()).toMatch(/of \d+$/);
      return countSays();
    }))![1]);
    await waitFor(() => expect([...collectRanges(document.body, words(word), false).values()].flat()).toHaveLength(total));
  });

  it.each([["descword", 1], ["thinkword", 3]])("a tool row and a Thinking row opened by a step draw what the count says for %s", async (word, total) => {
    await open();
    pressFind();
    fireEvent.click(within(bar()).getByRole("button", { name: FIND_WORDS.tools }));
    typeQuery(word);
    await settled(`${total} of ${total}`);
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect([...collectRanges(document.body, words(word), true).values()].flat()).toHaveLength(total));
  });

  it("draws nothing in a diagram or in math, which count nothing", async () => {
    await open();
    for (const word of ["mermaidword", "mathword"]) {
      expect([...collectRanges(document.body, words(word), true).values()].flat()).toHaveLength(0);
    }
  });

  it("draws nothing in a live row's hidden shimmer copy or in a list left behind after a switch", () => {
    const viewport = document.createElement("div");
    viewport.innerHTML = `
      <div data-find-entry="e1"><span data-find-part="0">refresh <span aria-hidden="true">refresh</span></span></div>
      <div inert><div data-find-entry="e2"><span data-find-part="0">refresh</span></div></div>`;
    const ranges = collectRanges(viewport, words("refresh"), true);
    expect([...ranges.keys()]).toEqual(["e1\n0"]);
    expect(ranges.get("e1\n0")).toHaveLength(1);
    expect(rangesIn(viewport.querySelector("[data-find-part]")!, words("refresh"))).toHaveLength(1);
  });
});

describe("find in thread: the whole history", () => {
  const finder = (): TimelineFinder => {
    const viewport = document.createElement("div");
    document.body.append(viewport);
    return { viewport, scroller: () => viewport, bottomEntry: () => -1, show: () => {} };
  };
  const entries = (events: SessionEvent[]) => deriveSession(events).timeline;

  it("pages in every event the host holds, saying N of M+ beside the spinner until the last page lands", async () => {
    const all = claudeThread();
    const pages = [all.slice(17), all.slice(0, 17)];
    let held = pages[0]!;
    let rerender: (whole: boolean) => void = () => {};
    const older = vi.fn(async () => {
      held = [...pages[1]!, ...pages[0]!];
      rerender(true);
      return false;
    });
    const at = finder();
    const draw = (whole: boolean) => <ThreadFind workspaceId={CLAUDE_WS} entries={entries(held)} cwd="/w" threadKey="t" finder={at} history={{ whole, trimmed: false, older }} />;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => (release = resolve));
    older.mockImplementationOnce(async () => {
      await gate;
      held = [...pages[1]!, ...pages[0]!];
      rerender(true);
      return false;
    });
    useThreadFind.setState({ open: true, query: "replyword" });
    const shown = render(draw(false));
    rerender = whole => shown.rerender(draw(whole));
    await waitFor(() => expect(countSays()).toBe("3 of 3+"));
    expect(bar().getAttribute("aria-busy")).toBe("true");
    expect(bar().querySelector("[role='status']")).not.toBeNull();
    expect(older).toHaveBeenCalledTimes(1);
    act(() => release());
    useThreadFind.setState({ query: "promptword" });
    await waitFor(() => expect(countSays()).toBe("1 of 1"));
    expect(bar().getAttribute("aria-busy")).toBe("false");
  });

  it("typing past the cap keeps the matches nearest the reader and scrolls nothing; Enter steps from the newest", async () => {
    const shown: string[] = [];
    const at = { ...finder(), show: (match: { entryId: string }) => void shown.push(match.entryId) };
    const timeline = entries(claudeThread());
    const textOf = (id: string) => {
      const entry = timeline.find(e => e.id === id);
      return entry?.kind === "message" ? entry.message.text : "";
    };
    useThreadFind.setState({ open: true, query: "" });
    render(<ThreadFind workspaceId={CLAUDE_WS} entries={timeline} cwd="/w" threadKey="t" finder={at} cap={2} history={{ whole: true, trimmed: false, older: async () => false }} />);
    for (const query of ["r", "re", "replyword"]) {
      act(() => useThreadFind.setState({ query }));
      await waitFor(() => expect(countSays()).toMatch(/^2 of 2\+$/));
    }
    expect(shown).toEqual([]);
    // Nothing is drawn under this finder, so the pick is out of sight: the first Enter shows it, the next steps older.
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(shown).toHaveLength(1));
    expect(countSays()).toBe("2 of 2+");
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(countSays()).toBe("1 of 2+"));
    expect(shown.map(textOf)).toEqual([expect.stringContaining("The newest replyword."), "And the last replyword?"]);
  });

  it("keeps the reader's place past the cap while older pages land above it", async () => {
    const all = claudeThread();
    let [held, whole] = [entries(all.slice(17)), false];
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => (release = resolve));
    let rerender: () => void = () => {};
    const older = async () => {
      await gate;
      [held, whole] = [entries(all), true];
      rerender();
      return false;
    };
    const shown: string[] = [];
    const at = { ...finder(), bottomEntry: () => held.length - 1, show: (match: { entryId: string }) => void shown.push(match.entryId) };
    const draw = () => <ThreadFind workspaceId={CLAUDE_WS} entries={held} cwd="/w" threadKey="t" finder={at} cap={2} history={{ whole, trimmed: false, older }} />;
    useThreadFind.setState({ open: true, query: "" });
    const view = render(draw());
    rerender = () => view.rerender(draw());
    act(() => useThreadFind.setState({ query: "r" }));
    await waitFor(() => expect(countSays()).toBe("2 of 2+"));
    const newest = held.at(-1)!.id;
    act(() => release());
    await waitFor(() => expect(bar().getAttribute("aria-busy")).toBe("false"));
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(shown).toEqual([newest]));
  });

  it("puts the toggles in a row of their own on a narrow screen, so the field keeps the room", () => {
    const narrow = (matches: boolean) =>
      vi.stubGlobal("matchMedia", (query: string) => ({ matches: matches && query.includes("max-width"), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
    for (const matches of [false, true]) {
      narrow(matches);
      useThreadFind.setState({ open: true, query: "replyword" });
      const shown = render(<ThreadFind workspaceId={CLAUDE_WS} entries={entries(claudeThread())} cwd="/w" threadKey="t" finder={finder()} history={{ whole: true, trimmed: false, older: async () => false }} />);
      const toggle = within(bar()).getByRole("button", { name: FIND_WORDS.matchCase });
      expect([matches, toggle.closest("[data-slot='input-group']") === null]).toEqual([matches, matches]);
      shown.unmount();
    }
  });

  it("says when the host's cap dropped the thread's oldest events", async () => {
    useThreadFind.setState({ open: true, query: "replyword" });
    render(<ThreadFind workspaceId={CLAUDE_WS} entries={entries(claudeThread())} cwd="/w" threadKey="t" finder={finder()} history={{ whole: true, trimmed: true, older: async () => false }} />);
    expect(bar().textContent).toContain(FIND_WORDS.trimmed);
  });
});
