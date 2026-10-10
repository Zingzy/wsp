// SPDX-License-Identifier: AGPL-3.0-only
import { createRef, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import { MessagesTimeline } from "../src/components/chat/MessagesTimeline";
import type { TimelineEntry, TurnSummary } from "../src/components/chat/adapt";
import { FIND_CURRENT_HIGHLIGHT, FIND_HIGHLIGHT, findMatches, findRanges, markdownText, type FindUnit } from "../src/components/chat/timeline/find";
import { FIND_WORDS } from "../src/components/chat/timeline/findBar";
import { SidebarProvider } from "../src/components/ui/sidebar";
import { KeybindingDispatcher } from "../src/shell/KeybindingDispatcher";

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// The list draws every row it is given: what this file proves is which rows the find opens and counts, not the
// list's window, which the live run measures.
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: { data: Array<{ id: string }>; keyExtractor: (item: { id: string }) => string; renderItem: (args: { item: { id: string } }) => ReactNode; ListFooterComponent?: ReactNode }) => (
    <div>
      {props.data.map(item => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  ),
}));

/** The page's highlight registry, which jsdom does not have: what is painted, by name. */
class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const painted = new Map<string, FakeHighlight>();
const paintedText = (name: string): string[] => (painted.get(name)?.ranges ?? []).map(range => range.toString());

const AT = "2026-10-10T10:00:00.000Z";
const OUTPUT = [...Array.from({ length: 200 }, (_, i) => `line ${i}: nothing here`), "line 200: the Needle sits deep in the output", ...Array.from({ length: 50 }, (_, i) => `line ${201 + i}`)].join("\n");
const LONG_ASK = [...Array.from({ length: 8 }, (_, i) => `Line ${i + 1}: ${"a long ask that clamps ".repeat(6)}`), "and one more needle at its very end"].join("\n");

function turn(turnId: string): TurnSummary {
  return { turnId, sessionId: "s1", state: "completed", replied: true, prompt: null, model: null, durationMs: 8000, waitedMs: null, costUsd: null, tokens: null, changes: null, error: null, startedAt: AT, completedAt: AT, checkpoint: null };
}

const message = (id: string, role: "user" | "assistant", text: string, turnId: string | null): TimelineEntry => ({
  id,
  kind: "message",
  createdAt: AT,
  message: { id, role, text, turnId, createdAt: AT, updatedAt: AT, streaming: false },
});

const call = (id: string, command: string, detail: string): TimelineEntry => ({
  id: `entry-${id}`,
  kind: "work",
  createdAt: AT,
  entry: { id, createdAt: AT, turnId: "t1", label: "Ran command", command, detail, tone: "tool", itemType: "command_execution", toolLifecycleStatus: "completed", sourceActivityKind: "tool.completed" },
});

const ENTRIES: TimelineEntry[] = [
  message("u1", "user", "Look into the parser", null),
  call("c1", "rg parser src", OUTPUT),
  call("c2", "ls", "README.md"),
  message("a1", "assistant", "Found the **needle** in the output.", "t1"),
  message("u2", "user", LONG_ASK, null),
];

function Thread() {
  return (
    <SidebarProvider defaultOpen>
      <KeybindingDispatcher />
      <div style={{ height: 600 }}>
        <MessagesTimeline
          isWorking={false}
          activeTurnStartedAt={null}
          listRef={createRef<LegendListRef | null>()}
          timelineEntries={ENTRIES}
          turns={[turn("t1")]}
          threadKey="ws/thread"
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>
    </SidebarProvider>
  );
}

const mod = () => (navigator.platform.startsWith("Mac") ? { metaKey: true } : { ctrlKey: true });
const field = () => screen.getByRole("searchbox", { name: FIND_WORDS.field }) as HTMLInputElement;
const count = () => document.querySelector("[data-find-count]")?.textContent ?? null;
const pressFind = () => fireEvent.keyDown(window, { key: "f", code: "KeyF", ...mod() });

beforeEach(() => {
  painted.clear();
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { ...globalThis.CSS, highlights: painted });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("find in thread", () => {
  it("opens on the find chord focused, and leaves the chord to the browser where no transcript is shown", () => {
    const { unmount } = render(<Thread />);
    expect(pressFind()).toBe(false);
    expect(document.activeElement).toBe(field());
    unmount();
    render(
      <SidebarProvider defaultOpen>
        <KeybindingDispatcher />
      </SidebarProvider>,
    );
    expect(pressFind()).toBe(true);
  });

  it("counts every match, folded ones too, and opens the folds and the call to show the current one", async () => {
    render(<Thread />);
    expect(screen.queryByText(/line 200/)).toBeNull();
    pressFind();
    fireEvent.change(field(), { target: { value: "needle" } });
    await waitFor(() => expect(count()).toBe("1 of 3"));
    // The settled turn, its group of calls and the call holding the match all stand open.
    expect(screen.getByRole("button", { name: /Worked for/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Ran 2 commands" }).getAttribute("aria-expanded")).toBe("true");
    const output = await screen.findByText(/line 200: the Needle sits deep/);
    expect(output.closest("[data-find-unit]")?.getAttribute("data-find-unit")).toBe("c1");
    await waitFor(() => expect(paintedText(FIND_CURRENT_HIGHLIGHT)).toEqual(["Needle"]));
    expect(painted.get(FIND_CURRENT_HIGHLIGHT)?.ranges[0]?.startContainer.parentElement?.closest("[data-find-unit]")?.getAttribute("data-find-unit")).toBe("c1");
    // Every match on the page is painted, the reply's bold one across its own text node, and the clamped ask's too.
    await waitFor(() => expect(paintedText(FIND_HIGHLIGHT)).toEqual(["Needle", "needle", "needle"]));
  });

  it("steps with Enter, Shift+Enter and the arrows, wraps, opens a clamped message, and Escape closes and clears", async () => {
    render(<Thread />);
    pressFind();
    const input = field();
    fireEvent.change(input, { target: { value: "NEEDLE" } });
    await waitFor(() => expect(count()).toBe("1 of 3"));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(count()).toBe("2 of 3");
    await waitFor(() => expect(painted.get(FIND_CURRENT_HIGHLIGHT)?.ranges[0]?.startContainer.parentElement?.closest("[data-find-unit]")?.getAttribute("data-find-unit")).toBe("a1"));
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(count()).toBe("1 of 3");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(count()).toBe("2 of 3");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(count()).toBe("3 of 3");
    // The clamped ask opens to show the match at its end.
    await waitFor(() => expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy());
    await waitFor(() => expect(painted.get(FIND_CURRENT_HIGHLIGHT)?.ranges[0]?.startContainer.parentElement?.closest("[data-find-unit]")?.getAttribute("data-find-unit")).toBe("u2"));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(count()).toBe("1 of 3");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(painted.size).toBe(0);
    act(() => void pressFind());
    expect(field().value).toBe("");
    expect(count()).toBe("");
  });

  it("says so when nothing matches, and the steps stand down", async () => {
    render(<Thread />);
    pressFind();
    fireEvent.change(field(), { target: { value: "absent words" } });
    await waitFor(() => expect(count()).toBe(FIND_WORDS.none));
    expect((screen.getByRole("button", { name: FIND_WORDS.next }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the words find reads", () => {
  it("reads markdown as the page draws it", () => {
    expect(markdownText("## Title\n- a **bold** [link](https://x.test) and `co*de*`\n```ts\nconst x = **y**;\n```\n> quote", true)).toBe("Title\na bold link and co*de*\nconst x = **y**;\nquote");
  });

  it("counts matches apart and ignores case", () => {
    const units: FindUnit[] = [{ key: "a", rowId: "a", order: 0, turnId: null, groupId: null, text: "aaaa" }];
    expect(findMatches(units, "AA")).toEqual({ unit: [0, 0], at: [0, 2] });
  });

  it("finds a match that runs across the page's text nodes", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p data-find-unit="m" data-find-text>a nee<b>dle</b> here<button>needle</button></p>`;
    const { all, current } = findRanges(root, "needle", { key: "m", nth: 0 });
    expect(all.map(range => range.toString())).toEqual(["needle"]);
    expect(current?.toString()).toBe("needle");
  });
});
