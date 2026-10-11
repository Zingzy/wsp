// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const drawn = vi.hoisted(() => ({ rows: new Map<string, number>(), subagents: new Map<string, number>() }));
vi.mock("../src/components/threads/ThreadRows.js", async importOriginal => {
  const { memo } = await import("react");
  const real = await importOriginal<typeof import("../src/components/threads/ThreadRows.js")>();
  // The row is a memo: count its draws inside it, behind the row's own comparison, where the tree draws it.
  const row = real.ThreadRow as unknown as { type: (props: { thread: { id: string } }) => ReactNode; compare: (a: object, b: object) => boolean };
  const subagentRow = real.SubagentRow as unknown as { type: (props: { subagent: { id: string } }) => ReactNode; compare: (a: object, b: object) => boolean };
  return {
    ...real,
    ThreadRow: memo((props: { thread: { id: string } }) => {
      drawn.rows.set(props.thread.id, (drawn.rows.get(props.thread.id) ?? 0) + 1);
      return row.type(props);
    }, row.compare),
    SubagentRow: memo((props: { subagent: { id: string } }) => {
      drawn.subagents.set(props.subagent.id, (drawn.subagents.get(props.subagent.id) ?? 0) + 1);
      return subagentRow.type(props);
    }, subagentRow.compare),
  };
});

import type { SubagentView } from "@wsp/protocol";
import type { SidebarThreadSnapshot } from "../src/adapt/index.js";
import { ThreadRow, type ThreadRowItem } from "../src/components/threads/ThreadRows.js";
import { useNotices } from "../src/notices/store.js";
import { useStore } from "../src/protocol/store.js";
import { TreeRows, type ChildNode } from "../src/tree/TreeRows.js";
import { pointerLeave } from "./pointer.js";

const NOW = new Date("2026-09-26T12:00:00Z");

const thread = (id: string, over: Partial<SidebarThreadSnapshot> = {}): SidebarThreadSnapshot => ({
  id,
  threadId: `thr_${id}`,
  sessionId: `sess_${id}`,
  workspaceId: "ws_api",
  title: id,
  status: "completed",
  ran: true,
  startedAt: "2026-09-26T11:00:00Z",
  endedAt: "2026-09-26T11:46:00Z",
  indicator: null,
  harness: "claude",
  startedBy: "agent",
  project: null,
  parentThreadId: "thr_lead",
  attempt: null,
  model: null,
  asking: null,
  costUsd: null,
  unread: false,
  readAt: null,
  settledAt: null,
  needsYou: false,
  pinnedAt: null, order: null,
  snoozedUntil: null,
  section: null,
  subagents: [],
  lastLine: null,
  failure: null,
  foldedAt: null, replaces: null, replacedBy: null,
  ...over,
});

const ROWS = [
  { thread: thread("Cart total rounding", { status: "running", startedAt: "2026-09-26T11:46:00Z", endedAt: null }), place: "Solari" },
  { thread: thread("Coupon expiry test"), place: "Solari" },
  { thread: thread("Address form race", { harness: "codex", asking: "Bash: pnpm install" }), place: "zingzy's MacBook Pro" },
  { thread: thread("Checkout end to end on Firefox", { status: "failed" }), place: "spoo" },
];

const list = (items: ReadonlyArray<ThreadRowItem>) =>
  render(
    <div>
      {items.map(row => (
        <ThreadRow key={row.thread.id} {...row} />
      ))}
    </div>,
  );
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-thread-row]")];

describe("a thread's row", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("draws one 36px line per thread", () => {
    list(ROWS.map(row => ({ ...row, place: "" })));
    expect(rows()).toHaveLength(4);
    for (const row of rows()) expect(row.className).toContain("h-9");
  });

  it("each line is the agent's mark, the title as the way to the thread, the computer leading its second line in muted sans and the status slot", () => {
    list(ROWS);
    const [working, resting, asking, failed] = rows();
    expect(working!.querySelector("[data-harness-mark]")).not.toBeNull();
    expect(asking!.querySelector<SVGElement>("[data-harness-mark]")!.dataset.harnessMark).toBe("codex");
    const link = working!.querySelector("a")!;
    expect(link.textContent).toBe("Cart total rounding");
    const place = working!.querySelector<HTMLElement>("[data-thread-place]")!;
    expect(place.textContent).toBe("Solari");
    const line = place.closest<HTMLElement>("[data-tree-note-line]")!;
    expect(line.className).toContain("text-[11px]");
    expect(line.className).toContain("text-muted-foreground");
    expect(line.className).not.toContain("font-mono");
    expect(working!.className).toContain("min-h-12");
    expect(asking!.querySelector("[data-thread-place]")!.textContent).toBe("zingzy's MacBook Pro");
    const status = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-thread-status]")!;
    expect(rows().map(row => status(row).dataset.threadStatus)).toEqual(["working", "resting", "needs-you", "failed"]);
    for (const row of rows()) expect(status(row).className).toContain("min-w-4");
    expect(status(working!).querySelector("[data-crab]")).not.toBeNull();
    expect(status(working!).getAttribute("aria-label")).toBe("Working");
    expect(status(working!).textContent).toBe("");
    expect(status(resting!).textContent).toBe("14m");
    expect(status(failed!).getAttribute("aria-label")).toBe("Failed");
    expect(status(failed!).textContent).toBe("");
  });

  it("joins nothing: no dot, no rule between the lines", () => {
    const { container } = list(ROWS);
    expect(container.textContent).not.toContain("·");
    expect(container.querySelector(".bg-border, hr")).toBeNull();
  });

  it("leaves the place out where the caller has no name for it, and the row one line high", () => {
    list([{ thread: thread("Local"), place: "" }]);
    expect(document.querySelector("[data-thread-place]")).toBeNull();
    expect(rows()[0]!.className).toContain("h-9");
  });

  it("a click on the title opens that thread", () => {
    const select = vi.fn();
    useStore.setState({ select } as never);
    list(ROWS);
    fireEvent.click(rows()[1]!.querySelector("a")!);
    expect(select).toHaveBeenCalledWith("ws_api", "thr_Coupon expiry test");
  });
});

const at = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const nodeOf = (t: SidebarThreadSnapshot, children: ChildNode[] = []): ChildNode => ({ thread: t, place: "", children });
const working = (id: string, minutes = 5): SidebarThreadSnapshot => thread(id, { status: "running", startedAt: at(minutes), endedAt: null });
const finished = (id: string, minutes: number): SidebarThreadSnapshot => thread(id, { startedAt: at(minutes + 10), endedAt: at(minutes), readAt: at(minutes), lastLine: `${id} is pushed.` });
const tree = (nodes: ChildNode[], lead: SidebarThreadSnapshot | null = null) => <TreeRows leadThread={lead} leadPlace="" nodes={nodes} />;

describe("a lead's children as rows", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    drawn.rows.clear();
    drawn.subagents.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useStore.setState({ api: null } as never);
  });

  it("keeps the acts' room beside the status from md up, shows the acts on the row's own hover with no pill, and none under md", () => {
    useStore.setState({ api: { interruptSession: vi.fn() } } as never);
    render(tree([nodeOf(working("Cart total rounding"))]));
    const row = rows()[0]!;
    expect(row.className).toContain("group/row");
    expect(row.className).toContain("hover:bg-accent");
    const acts = row.querySelector<HTMLElement>("[data-child-acts]")!;
    // A tree mounts every row as its lead opens: the acts mount once the pointer reaches the row, and stay.
    expect(acts.querySelectorAll("button")).toHaveLength(0);
    fireEvent.pointerEnter(row);
    fireEvent.pointerLeave(row);
    expect([...acts.querySelectorAll("button")].map(b => b.getAttribute("aria-label"))).toEqual(["Send a message", "Stop thread", "More"]);
    // At rest and under md nothing is drawn; on hover or focus they fade in, on no fill of their own.
    expect(acts.className).toContain("opacity-0");
    expect(acts.className).toContain("max-md:hidden");
    expect(acts.className).toContain("group-hover/row:opacity-100");
    expect(acts.className).toContain("group-focus-within/row:opacity-100");
    expect(acts.className).not.toMatch(/(^|\s)bg-|rounded-full|border/);
    // Each glyph is the 24 px ghost button, its own hover square the only fill it takes.
    for (const button of acts.querySelectorAll("button")) expect(button.className).toMatch(/size-6.*border-transparent|border-transparent.*size-6/);
    // The room is the three 24 px glyphs and their gaps, kept from md up, so the title's width never moves.
    const room = acts.parentElement!;
    expect(room.className).toContain("md:min-w-20");
    expect(room.querySelector("[data-thread-status]")!.parentElement!.className).toContain("md:group-hover/row:invisible");
    // A client that cannot stop a turn draws no Stop, and the room shrinks to what is drawn.
    cleanup();
    useStore.setState({ api: null } as never);
    render(tree([nodeOf(working("Cart total rounding"))]));
    expect(rows()[0]!.querySelector("[data-child-acts]")!.parentElement!.className).toContain("md:min-w-13");
  });

  it("a row's Stop is two presses: armed, the other acts give way to its word in the room they held, and a second press stops", async () => {
    const interruptSession = vi.fn(async () => ({ outcome: "accepted" as const }));
    useStore.setState({ api: { interruptSession } } as never);
    render(tree([nodeOf(working("Cart total rounding"))]));
    const row = rows()[0]!;
    expect(row.hasAttribute("data-stop-row")).toBe(true);
    fireEvent.pointerEnter(row);
    const acts = row.querySelector<HTMLElement>("[data-child-acts]")!;
    const room = acts.parentElement!.className;
    const stop = (): HTMLElement => acts.querySelector<HTMLElement>("[data-stop-act]")!;
    fireEvent.click(stop());
    expect(interruptSession).not.toHaveBeenCalled();
    expect([...acts.querySelectorAll("button")].map(b => b.getAttribute("aria-label"))).toEqual(["Press again to stop"]);
    expect(stop().textContent).toBe("Stop");
    expect(acts.parentElement!.className).toBe(room);
    pointerLeave(row);
    expect([...acts.querySelectorAll("button")].map(b => b.getAttribute("aria-label"))).toEqual(["Send a message", "Stop thread", "More"]);
    fireEvent.click(stop());
    fireEvent.click(stop());
    await waitFor(() => expect(interruptSession).toHaveBeenCalledWith("sess_Cart total rounding"));
  });

  it("mounts a row's acts as focus lands on its title, after the title, and at once where the title is no link", () => {
    useStore.setState({ api: { interruptSession: vi.fn() } } as never);
    render(tree([nodeOf(working("Cart total rounding"))]));
    const row = rows()[0]!;
    expect(row.querySelectorAll("[data-child-acts] button")).toHaveLength(0);
    const link = row.querySelector<HTMLAnchorElement>("a[href]")!;
    act(() => link.focus());
    const acts = [...row.querySelectorAll<HTMLElement>("[data-child-acts] button")];
    expect(acts.map(b => b.getAttribute("aria-label"))).toEqual(["Send a message", "Stop thread", "More"]);
    expect(link.compareDocumentPosition(acts[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    render(tree([nodeOf(thread("Starting", { status: "running", startedAt: at(1), endedAt: null, threadId: null }))]));
    expect(rows()[0]!.querySelector("a")).toBeNull();
    expect(rows()[0]!.querySelectorAll("[data-child-acts] button").length).toBeGreaterThan(0);
  });

  it("Send a message opens the field in the second line's place: Enter sends to that thread and closes it, Escape cancels", () => {
    const startSession = vi.fn(async () => ({}) as never);
    useStore.setState({ api: { startSession } } as never);
    render(tree([nodeOf(finished("Coupon expiry test", 30), []), nodeOf(working("Cart total rounding"))]));
    const row = document.querySelector<HTMLElement>('[data-thread-row="Cart total rounding"]')!;
    fireEvent.pointerEnter(row);
    fireEvent.click(row.querySelector<HTMLElement>('[aria-label="Send a message"]')!);
    const field = row.querySelector<HTMLInputElement>("[data-row-name-input]")!;
    expect(field.placeholder).toBe("Send a message");
    expect(field.getAttribute("aria-label")).toBe("Message to Cart total rounding");
    expect(row.querySelector("[data-child-acts]")).toBeNull();
    fireEvent.change(field, { target: { value: "rebase onto main first" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws_api", thread: "thr_Cart total rounding", prompt: "rebase onto main first", harness: "claude" }));
    expect(row.querySelector("[data-row-name-input]")).toBeNull();
    fireEvent.click(row.querySelector<HTMLElement>('[aria-label="Send a message"]')!);
    fireEvent.keyDown(row.querySelector<HTMLInputElement>("[data-row-name-input]")!, { key: "Escape" });
    expect(row.querySelector("[data-row-name-input]")).toBeNull();
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("counts the open message field as the row's second line, so the elbow meets a nested row at its middle", () => {
    useStore.setState({ api: { startSession: vi.fn() } } as never);
    render(tree([nodeOf(working("Cart total rounding"), [nodeOf(working("Rounding probe"))])]));
    const row = document.querySelector<HTMLElement>('[data-thread-row="Rounding probe"]')!;
    const item = row.closest("li")!;
    expect(item.hasAttribute("data-two")).toBe(false);
    fireEvent.pointerEnter(row);
    fireEvent.click(row.querySelector<HTMLElement>('[aria-label="Send a message"]')!);
    expect(row.querySelector("[data-row-name-input]")).not.toBeNull();
    expect(item.hasAttribute("data-two")).toBe(true);
  });

  it("a fold row draws its icon, count and chevron; shut it mounts no row, open it mounts twenty and a row for the rest", () => {
    const done = Array.from({ length: 25 }, (_, i) => nodeOf(finished(`done ${i}`, 10 + i)));
    const put = [nodeOf(thread("put away", { endedAt: at(50), readAt: at(50), settledAt: at(40) })), nodeOf(thread("put away too", { endedAt: at(60), readAt: at(60), settledAt: at(55) }))];
    render(tree([...done, nodeOf(working("Cart total rounding")), ...put]));
    const fold = (name: string) => document.querySelector<HTMLElement>(`[data-child-fold="${name}"]`)!;
    const partRows = (part: string) => document.querySelectorAll(`[data-child-part="${part}"]`).length;
    expect(fold("finished").querySelector("[data-fold-icon]")!.getAttribute("class")).toContain("lucide-circle-check");
    expect(fold("finished").textContent).toBe("Finished25");
    expect(fold("finished").getAttribute("aria-expanded")).toBe("false");
    expect(fold("finished").querySelector("[data-fold-chevron]")!.getAttribute("class")).toContain("-rotate-90");
    expect(fold("settled").querySelector("[data-fold-icon]")!.getAttribute("class")).toContain("lucide-archive");
    expect(fold("settled").textContent).toBe("Settled2");
    expect(partRows("finished")).toBe(0);
    expect(partRows("settled")).toBe(0);
    fireEvent.click(fold("finished"));
    expect(fold("finished").getAttribute("aria-expanded")).toBe("true");
    expect(fold("finished").querySelector("[data-fold-chevron]")!.getAttribute("class")).not.toContain("-rotate-90");
    expect(partRows("finished")).toBe(20);
    expect(fold("more").textContent).toBe("5 more");
    expect(fold("more").querySelector("[data-fold-icon]")!.getAttribute("class")).toContain("lucide-chevrons-down");
    fireEvent.click(fold("more"));
    expect(partRows("finished")).toBe(25);
    expect(document.querySelector('[data-child-fold="more"]')).toBeNull();
    // Newest end first, each with its last line under its title.
    expect(document.querySelector('[data-child-part="finished"] [data-tree-note]')!.textContent).toBe("done 0 is pushed.");
    fireEvent.click(fold("settled"));
    expect(partRows("settled")).toBe(2);
  });

  it("stands a subagent under the thread whose agent runs it, led by the bot, with Stop subagent alone while it runs", () => {
    const lead = thread("lead", { status: "running", startedAt: at(20), endedAt: null, subagents: [{ id: "task_1", title: "Read the open tickets", state: "running", startedAt: NOW.getTime() - 60_000, asked: "Read every open ticket." }] });
    useStore.setState({ api: { interruptSession: vi.fn() } } as never);
    render(tree([nodeOf(working("Cart total rounding"))], lead));
    const row = document.querySelector<HTMLElement>('[data-subagent-row="task_1"]')!;
    expect(row.querySelector("[data-subagent-mark]")!.getAttribute("class")).toContain("lucide-bot");
    expect(row.textContent).toContain("Read the open tickets");
    // Its title is no link, so its act is the row's one tab stop and stands mounted at rest.
    expect(row.querySelector("a, [tabindex]")).toBeNull();
    expect([...row.querySelectorAll("[data-child-acts] button")].map(b => b.getAttribute("aria-label"))).toEqual(["Stop subagent"]);
    // Stop alone keeps room for its armed word, so the title's width never moves when it arms.
    expect(row.querySelector("[data-child-acts]")!.parentElement!.className).toContain("md:min-w-13");
  });

  it("redraws only the row whose thread moved, among twelve", () => {
    const twelve = (moved?: (t: SidebarThreadSnapshot) => SidebarThreadSnapshot) =>
      Array.from({ length: 12 }, (_, i) => {
        const t = working(`child ${i}`, 30 - i);
        return nodeOf(i === 5 && moved !== undefined ? moved(t) : { ...t });
      });
    const view = render(tree(twelve()));
    expect([...drawn.rows.values()].reduce((a, b) => a + b, 0)).toBe(12);
    drawn.rows.clear();
    // Every listing reads every row again as new objects; only the one that asks now draws again.
    view.rerender(tree(twelve(t => ({ ...t, asking: "Bash: pnpm install" }))));
    expect(Object.fromEntries(drawn.rows)).toEqual({ "child 5": 1 });
    drawn.rows.clear();
    view.rerender(tree(twelve(t => ({ ...t, asking: "Bash: pnpm install" }))));
    expect(drawn.rows.size).toBe(0);
  });

  it("redraws only the subagent row that moved, among twelve, and none when the listing is read again unchanged", () => {
    const lead = (moved?: (sub: SubagentView) => SubagentView) =>
      thread("lead", {
        status: "running",
        startedAt: at(20),
        endedAt: null,
        subagents: Array.from({ length: 12 }, (_, i) => {
          const sub: SubagentView = { id: `sa_${i}`, title: `subagent ${i}`, state: "running", parentToolUseId: `toolu_${i}`, startedAt: NOW.getTime() - (30 - i) * 60_000, asked: `Read part ${i}` };
          return i === 5 && moved !== undefined ? moved(sub) : sub;
        }),
      });
    const view = render(tree([], lead()));
    expect([...drawn.subagents.values()].reduce((a, b) => a + b, 0)).toBe(12);
    drawn.subagents.clear();
    view.rerender(tree([], lead()));
    expect(drawn.subagents.size).toBe(0);
    view.rerender(tree([], lead(sub => ({ ...sub, model: "claude-opus-5-5" }))));
    expect(Object.fromEntries(drawn.subagents)).toEqual({ sa_5: 1 });
  });

  it("redraws a row whose restart link moved, since its menu reads both ends", () => {
    const twelve = (moved?: (t: SidebarThreadSnapshot) => SidebarThreadSnapshot) =>
      Array.from({ length: 12 }, (_, i) => {
        const t = working(`child ${i}`, 30 - i);
        return nodeOf(i === 5 && moved !== undefined ? moved(t) : { ...t });
      });
    const view = render(tree(twelve()));
    drawn.rows.clear();
    view.rerender(tree(twelve(t => ({ ...t, replacedBy: "thr_redo" }))));
    expect(Object.fromEntries(drawn.rows)).toEqual({ "child 5": 1 });
    drawn.rows.clear();
    view.rerender(tree(twelve(t => ({ ...t, replacedBy: "thr_redo", replaces: { threadId: "thr_old", failed: false, endedAt: null } }))));
    expect(Object.fromEntries(drawn.rows)).toEqual({ "child 5": 1 });
  });
});

describe("the Threads section's head", () => {
  const LEAD_THREAD = working("lead", 40);
  const CAP = { placeId: "here", place: "Solari", running: 6, atOnce: 6 };
  const shutFor = (shut: boolean) =>
    useStore.setState(s => ({ api: { ...(s.api ?? {}), setPreferences: vi.fn() }, preferences: { ...s.preferences, threadsShut: shut ? { [LEAD_THREAD.id]: true } : {} } }) as never);
  const head = () => document.querySelector<HTMLElement>("[data-threads-head]")!;
  const counts = () => [...head().querySelectorAll<HTMLElement>("[data-tree-count]")].map(c => [c.dataset.treeCount, c.textContent, c.title]);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    useNotices.setState({ notices: [], toasts: [] } as never);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useStore.setState(s => ({ api: null, preferences: { ...s.preferences, threadsShut: {} } }) as never);
  });

  it("offers Settle N finished while open, over every finished thread in the tree, and its toast's Undo brings them back", async () => {
    const settleThreads = vi.fn(async (ids: readonly string[]) => ({ settled: [...ids, "c"].map(threadId => ({ threadId, title: threadId })), left: [] }));
    const restoreThreads = vi.fn(async () => undefined);
    useStore.setState({ api: { settleThreads, restoreThreads, setPreferences: vi.fn() } } as never);
    render(tree([nodeOf(finished("a", 5)), nodeOf(finished("b", 6), [nodeOf(finished("c", 7))]), nodeOf(working("w"))], LEAD_THREAD));
    // Open, the head says no counts.
    expect(counts()).toEqual([]);
    const settle = head().querySelector<HTMLButtonElement>("[data-settle-finished]")!;
    expect(settle.textContent).toBe("Settle 3 finished");
    await act(async () => fireEvent.click(settle));
    expect(settleThreads).toHaveBeenCalledWith(["a", "b"]);
    const notice = await waitFor(() => useNotices.getState().notices.find(n => n.text === "Settled 3 threads")!);
    expect(notice.action?.word).toBe("Undo");
    notice.action!.run();
    expect(restoreThreads).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("says the tree's counts only while shut, each hover in its own words, and offers no Settle there", () => {
    shutFor(true);
    render(tree([nodeOf(thread("ask", { status: "running", startedAt: at(3), endedAt: null, asking: "Bash: pnpm install" })), nodeOf(thread("held 1", { status: "running", startedAt: at(4), endedAt: null, capped: CAP })), nodeOf(thread("held 2", { status: "running", startedAt: at(5), endedAt: null, capped: CAP })), nodeOf(finished("done", 5))], LEAD_THREAD));
    expect(counts()).toEqual([
      ["needs-you", "1", "1 needs you"],
      ["waiting", "2", "2 waiting"],
    ]);
    expect(head().querySelector("[data-settle-finished]")).toBeNull();
  });

  it("with nothing live, says how many finished in words, in the muted ink", () => {
    shutFor(true);
    render(tree([nodeOf(finished("a", 5)), nodeOf(finished("b", 6), [nodeOf(finished("c", 7)), nodeOf(finished("d", 8))])], LEAD_THREAD));
    const count = head().querySelector<HTMLElement>('[data-tree-count="finished"]')!;
    expect(count.textContent).toBe("4 finished");
    expect(count.className).toContain("text-muted-foreground");
    expect(count.querySelector("svg")).toBeNull();
  });
});
