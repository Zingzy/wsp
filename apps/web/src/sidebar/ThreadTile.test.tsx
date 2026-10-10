// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { threadIndicator } from "../adapt/index.js";
import { SidebarProvider } from "../components/ui/sidebar.js";
import { TooltipProvider } from "../components/ui/tooltip.js";
import { ThreadTile, WorkspaceTile, useTileHandlers, type TilePlace } from "./ThreadTile.js";
import { SubagentRow } from "./SubagentRow.js";
import { settlesOnHover } from "./LeadTree.js";
import { tileTree, type TileNode } from "./threadTree.js";
import { childTarget, kindOf, noteOf } from "../components/threads/leadTree.js";
import type { SubagentView } from "@wsp/protocol";
import { useStore } from "../protocol/store.js";
import type { TileCheckout } from "./tileCheckout.js";
import type { PlaceView } from "@wsp/protocol";

const thread = (over: Partial<SidebarThreadSnapshot> = {}): SidebarThreadSnapshot => {
  const base = { id: "th_1", threadId: "th_1", sessionId: "s_1", workspaceId: "ws_a", title: "Cart total rounding", status: "running" as const, ran: true, startedAt: "2026-09-17T00:00:00.000Z", endedAt: null, harness: "claude", startedBy: "person" as const, project: "spoo", parentThreadId: null, attempt: null, model: null, asking: null, costUsd: null, unread: false, readAt: null, settledAt: null, needsYou: false, pinnedAt: null, snoozedUntil: null, section: null, subagents: [], lastLine: null, failure: null, foldedAt: null, replaces: null, replacedBy: null };
  const merged = { ...base, ...over };
  return { ...merged, indicator: threadIndicator({ status: merged.status, ...(merged.asking === null ? {} : { asking: merged.asking }) }) };
};

const HERE: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", mac: "macbook", default: true, present: true, takesForks: false, engine: "none", shape: { cpu: 8, memMb: 16384 }, diskFreeBytes: 210 * 1024 ** 3 };
const PLACE: TilePlace = { projectId: "pr_1", project: "spoo-landing", computer: "zingzy's MacBook Pro", at: HERE };

function mount({ over = {}, checkout = { branch: "fix/cart-rounding", counts: [] }, active = false, settled = false, snoozedWorking, onSelect = () => {} }: { over?: Partial<SidebarThreadSnapshot>; checkout?: TileCheckout; active?: boolean; settled?: boolean; snoozedWorking?: number; onSelect?: () => void } = {}) {
  return render(
    <SidebarProvider defaultOpen>
      <ThreadTile
        thread={thread(over)}
        place={PLACE}
        checkout={checkout}
        model="Opus 5.5"
        time="3m"
        depth={1}
        active={active}
        settled={settled}
        {...(snoozedWorking === undefined ? {} : { snoozedWorking })}
        renaming={false}
        saving={false}
        onSelect={onSelect}
        onContextMenu={() => {}}
        onRename={() => {}}
        onRenameCancel={() => {}}
      />
    </SidebarProvider>,
  );
}

const tile = (): HTMLElement => document.querySelector<HTMLElement>("[data-sidebar-row]")!;
const rows = (): HTMLElement[] => Array.from(tile().children) as HTMLElement[];
const slot = (): HTMLElement => tile().querySelector<HTMLElement>("[data-thread-status]")!;

afterEach(cleanup);

/** Rests the pointer on an act, as a mouse comes onto it; the timers are fake, so the caller says how long passes. */
const pointAt = (el: HTMLElement): void => {
  fireEvent.pointerEnter(el, { pointerType: "mouse" });
  fireEvent.mouseEnter(el);
  fireEvent.mouseMove(el);
};

/** What the app's tooltips say once this much more time has passed. */
const tipsAfter = async (ms: number): Promise<string[]> => {
  await act(async () => void vi.advanceTimersByTime(ms));
  return [...document.querySelectorAll("[data-slot=tooltip-popup]")].map(popup => popup.textContent ?? "");
};

describe("a thread tile", () => {
  it("a thread whose agent the host refuses to start there says Refused in its slot with the host's sentence on its hover and its card", () => {
    const sentence = "Claude Code does not start with its config folder ~/claude-wsp: it is not under the home folder /Users/dev. Set another with wsp agents setup claude --config, or put its own back with --reset config.";
    mount({ over: { status: "failed", endedAt: "2026-09-17T00:05:00.000Z", setupRefusal: sentence } });
    expect(slot().textContent).toBe("Refused");
    expect(slot().dataset["threadStatus"]).toBe("setup-refused");
    expect(slot().getAttribute("title")).toBe(sentence);
    cleanup();
    mount({ over: { status: "running", setupRefusal: sentence } });
    expect(slot().textContent).not.toContain("Refused");
  });

  it("a thread its computer's threads at once holds back says Waiting with the hourglass, no time and no crab, and its card says what holds it and how to raise it", async () => {
    vi.useFakeTimers();
    try {
      mount({ over: { status: "running", capped: { placeId: "p_hetzner", place: "hetzner", running: 2, atOnce: 2 } } });
      expect(slot().dataset["threadStatus"]).toBe("waiting");
      expect(slot().dataset["tone"]).toBeUndefined();
      expect(slot().getAttribute("aria-label")).toBe("Waiting");
      expect(slot().textContent).toBe("");
      expect(slot().querySelector("svg")!.getAttribute("class")).toContain("lucide-hourglass");
      expect(tile().querySelector("[data-crab]")).toBeNull();
      fireEvent.pointerEnter(tile(), { pointerType: "mouse" });
      fireEvent.mouseEnter(tile());
      fireEvent.mouseMove(tile());
      await act(async () => void vi.advanceTimersByTime(600));
      const notes = [...document.querySelectorAll<HTMLElement>('[data-tile-card] [data-tile-card-line="note"]')].map(line => line.textContent);
      expect(document.querySelector("[data-tile-card] [data-status-line=waiting] [data-status-reason]")!.textContent).toBe("hetzner is running 2 of 2 threads");
      expect(notes).toEqual(["Raise threads at once on hetzner in Settings to start it now"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("in the Settled fold rests whatever its state: its age in the row's ink, no tone, no glyph, and a muted title", () => {
    mount({ over: { status: "failed", endedAt: "2026-09-17T00:05:00.000Z" }, settled: true });
    expect(slot().textContent).toBe("3m");
    expect(slot().dataset["tone"]).toBeUndefined();
    expect(slot().querySelector("svg")).toBeNull();
    expect([...slot().classList].filter(c => c.startsWith("text-status-"))).toEqual([]);
    expect(tile().querySelector("[data-thread-title]")!.className).toContain("text-sidebar-muted-foreground");
    cleanup();
    mount({ over: { status: "completed", endedAt: "2026-09-17T00:05:00.000Z", unread: true }, settled: true });
    expect(slot().textContent).toBe("3m");
  });

  it("a snoozed root whose threads work says how many in its slot, quietly: the snooze's glyph and the count, no tone, no crab, a muted title", () => {
    mount({ over: { status: "completed", endedAt: "2026-09-17T00:05:00.000Z", snoozedUntil: "2026-09-17T06:00:00.000Z" }, snoozedWorking: 2 });
    expect(slot().textContent).toBe("2 working");
    expect(slot().dataset["threadStatus"]).toBe("snoozed");
    expect(slot().dataset["tone"]).toBeUndefined();
    expect(slot().querySelector("svg")).not.toBeNull();
    expect([...slot().classList].filter(c => c.startsWith("text-status-"))).toEqual([]);
    expect(tile().querySelector("canvas")).toBeNull();
    expect(tile().querySelector("[data-thread-title]")!.className).toContain("text-sidebar-muted-foreground");
    expect(tile().hasAttribute("title")).toBe(false);
  });

  it("a finish nobody has seen says Done in the slot and keeps its title in the foreground ink; opened, it rests with its age and a muted title", () => {
    mount({ over: { status: "completed", endedAt: "2026-09-17T00:05:00.000Z", unread: true } });
    expect(slot().getAttribute("aria-label")).toBe("Done");
    expect(slot().textContent).toBe("");
    expect(slot().dataset["tone"]).toBe("done");
    const title = tile().querySelector("[data-thread-title]")!;
    expect(title.className).toContain("text-sidebar-foreground");
    expect(title.className).not.toContain("text-sidebar-muted-foreground");
    expect(tile().querySelector("canvas")).toBeNull();
    cleanup();
    mount({ over: { status: "completed", endedAt: "2026-09-17T00:05:00.000Z", unread: false } });
    expect(slot().textContent).toBe("3m");
    expect(tile().querySelector("[data-thread-title]")!.className).toContain("text-sidebar-muted-foreground");
  });

  it("is two rows: where it runs with the status at the right, then the agent's mark and the title, and nothing of the branch", () => {
    mount({ over: { status: "failed" } });
    expect(rows()).toHaveLength(2);
    const [one, two] = rows();
    expect(one!.querySelector("svg")).not.toBeNull();
    expect(one!.querySelector("[data-tile-where]")!.textContent).toBe("spoo-landing @ zingzy's MacBook Pro");
    expect(one!.lastElementChild).toBe(slot());
    expect(slot().getAttribute("aria-label")).toBe("Failed");
    expect(slot().textContent).toBe("");
    expect(two!.firstElementChild!.matches("[data-harness-mark=claude]")).toBe(true);
    expect(two!.querySelector("[data-thread-title]")!.textContent).toBe("Cart total rounding");
    expect(tile().querySelector(".lucide-git-branch, [data-tile-branch]")).toBeNull();
    expect(tile().textContent).not.toMatch(/fix\/cart-rounding|[·•]/);
  });

  it("draws the tile at its sizes: 52 px, rows of 14 and 18 with 4 px between, row one at 11 px", () => {
    mount();
    expect(tile().className).toContain("h-[52px]");
    expect(tile().className).toContain("gap-1");
    expect(tile().className).toContain("p-2");
    const [one, two] = rows();
    expect(one!.className).toContain("h-3.5");
    expect(one!.className).toContain("text-[11px]");
    expect(two!.className).toContain("h-[18px]");
    expect(two!.querySelector("[data-thread-title]")!.className).toContain("text-sm");
  });

  it("walks one crab while working, in row one's status slot as its icon alone, and row two ends in none", () => {
    mount();
    expect(tile().querySelectorAll("canvas[data-crab]")).toHaveLength(1);
    expect(slot().querySelector("canvas[data-crab]")).not.toBeNull();
    expect(rows()[0]!.lastElementChild).toBe(slot());
    expect(rows()[1]!.querySelector("canvas")).toBeNull();
    expect(slot().dataset["tone"]).toBe("working");
    expect(slot().getAttribute("aria-label")).toBe("Working");
    expect(slot().textContent).toBe("");
    cleanup();
    for (const over of [{ status: "failed" as const }, { status: "completed" as const }, { asking: "Write out.txt" }]) {
      mount({ over });
      expect(tile().querySelector("canvas"), JSON.stringify(over)).toBeNull();
      cleanup();
    }
  });

  it("ends row two in one small muted icon while its pull request is open, no number and no colour; merged or closed, nothing", () => {
    mount({ over: { status: "completed" }, checkout: { branch: "fix/cart-rounding", counts: [], pr: { number: 42, state: "open", url: "u" } } });
    const icon = rows()[1]!.querySelector<SVGElement>("[data-tile-pr]")!;
    expect(icon.matches(".lucide-git-pull-request")).toBe(true);
    expect(icon.getAttribute("class")).toContain("text-[var(--top-row-meta)]");
    expect(tile().textContent).not.toContain("42");
    for (const state of ["merged", "closed"] as const) {
      cleanup();
      mount({ over: { status: "completed" }, checkout: { branch: "fix/cart-rounding", counts: [], pr: { number: 42, state, url: "u" } } });
      expect(tile().querySelector("[data-tile-pr]"), state).toBeNull();
    }
  });

  it("opens a card to its right once the pointer rests on it: the full title, where it runs, the branch, the model, the pull request as a word, the changes", async () => {
    vi.useFakeTimers();
    try {
      mount({ over: { status: "completed", asking: "Permission for Bash: pnpm install" }, checkout: { branch: "fix/cart-rounding", counts: [], changed: "3 changed", pr: { number: 42, state: "merged", url: "u" } } });
      fireEvent.pointerEnter(tile(), { pointerType: "mouse" });
      fireEvent.mouseEnter(tile());
      fireEvent.mouseMove(tile());
      expect(document.querySelector("[data-tile-card]")).toBeNull();
      await act(async () => void vi.advanceTimersByTime(600));
      const card = document.querySelector<HTMLElement>("[data-tile-card]")!;
      expect(card.querySelector("[data-tile-card-title]")!.textContent).toBe("Cart total rounding");
      expect([...card.querySelectorAll<HTMLElement>("[data-tile-card-line]")].map(line => [line.dataset["tileCardLine"], line.textContent])).toEqual([
        ["project", "spoo-landing"],
        ["computer", "zingzy's MacBook Pro"],
        ["branch", "fix/cart-rounding"],
        ["agent", "Opus 5.5"],
        ["pr", "Pull request #42, merged"],
        ["changed", "3 changed"],
      ]);
      // The card leads with the status row, what it waits on whole under the word.
      const status = card.querySelector("ul")!.firstElementChild as HTMLElement;
      expect(status.dataset["statusLine"]).toBe("needs-you");
      expect(status.querySelector("[data-status-reason]")!.textContent).toBe("Permission for Bash: pnpm install");
      // The computer's icon is the registry's, the one the Computers page draws for this Mac.
      expect(card.querySelector('[data-tile-card-line="computer"] [data-computer-glyph]')?.getAttribute("data-computer-glyph")).toBe("laptop");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a done tile's card says the last line of what the thread said under Done; a working one's says nothing from the turn before", async () => {
    vi.useFakeTimers();
    try {
      const reasonOf = async (over: Partial<SidebarThreadSnapshot>): Promise<string | null> => {
        mount({ over: { lastLine: "Opened acme/lab#42 and the gate is green.", ...over } });
        pointAt(tile());
        await act(async () => void vi.advanceTimersByTime(600));
        const reason = document.querySelector("[data-tile-card] [data-status-line] [data-status-reason]")?.textContent ?? null;
        cleanup();
        return reason;
      };
      expect(await reasonOf({ status: "completed", endedAt: "2026-09-17T00:05:00.000Z", unread: true })).toBe("Opened acme/lab#42 and the gate is green.");
      expect(await reasonOf({ status: "completed", endedAt: "2026-09-17T00:05:00.000Z", unread: false })).toBe("Opened acme/lab#42 and the gate is green.");
      expect(await reasonOf({ status: "running" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the sidebar button's slot under the card's trigger, the slot the sidebar's styles and measures find a row by", () => {
    mount({ over: { status: "completed" }, checkout: { branch: "fix/cart-rounding", counts: [] } });
    expect(tile().dataset["slot"]).toBe("sidebar-menu-button");
  });

  it("shuts its card when the tile is pressed, so a right-click's menu never stands beside it", async () => {
    vi.useFakeTimers();
    try {
      mount({ over: { status: "completed" }, checkout: { branch: "fix/cart-rounding", counts: [] } });
      fireEvent.pointerEnter(tile(), { pointerType: "mouse" });
      fireEvent.mouseEnter(tile());
      fireEvent.mouseMove(tile());
      await act(async () => void vi.advanceTimersByTime(600));
      expect(document.querySelector("[data-tile-card]")).not.toBeNull();
      fireEvent.pointerDown(tile(), { button: 2, pointerType: "mouse" });
      fireEvent.contextMenu(tile());
      await act(async () => void vi.advanceTimersByTime(600));
      expect(document.querySelector("[data-tile-card]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a resting or working thread's title recedes, the open one's does not, and a resting slot reads the age", () => {
    mount({ over: { status: "completed" } });
    expect(rows()[1]!.querySelector("[data-thread-title]")!.className).toContain("text-sidebar-muted-foreground");
    expect(slot().textContent).toBe("3m");
    cleanup();
    mount();
    expect(rows()[1]!.querySelector("[data-thread-title]")!.className).toContain("text-sidebar-muted-foreground");
    cleanup();
    mount({ active: true });
    expect(rows()[1]!.querySelector("[data-thread-title]")!.className).toContain("text-sidebar-foreground");
  });

  it("a thread a stop ended reads Stopped in the row's muted ink, not Done, and its title recedes", () => {
    mount({ over: { status: "interrupted", endedAt: "2026-09-17T00:05:00.000Z", unread: true } });
    expect(slot().dataset["threadStatus"]).toBe("stopped");
    expect(slot().getAttribute("aria-label")).toBe("Stopped");
    expect(slot().dataset["tone"]).toBeUndefined();
    expect(slot().querySelector("svg")!.getAttribute("class")).toContain("lucide-circle-stop");
    expect(rows()[1]!.querySelector("[data-thread-title]")!.className).toContain("text-sidebar-muted-foreground");
  });

  it("the slot's tooltip ticks the time a turn has run on its own node, and the tile is drawn no more while it does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-17T00:01:22.000Z"));
      const commits = vi.fn();
      render(
        <Profiler id="tile" onRender={commits}>
          <SidebarProvider defaultOpen>
            <ThreadTile thread={thread()} place={PLACE} model={null} time="3m" depth={0} active={false} renaming={false} saving={false} onSelect={() => {}} onContextMenu={() => {}} onRename={() => {}} onRenameCancel={() => {}} />
          </SidebarProvider>
        </Profiler>,
      );
      fireEvent.pointerEnter(slot(), { pointerType: "mouse" });
      fireEvent.mouseEnter(slot());
      fireEvent.mouseMove(slot());
      await act(async () => void vi.advanceTimersByTime(1_000));
      const tip = (): string => document.querySelector("[data-slot=tooltip-popup]")?.textContent ?? "";
      expect(tip()).toBe("Working 1m 22s");
      const drawn = commits.mock.calls.length;
      for (const want of ["Working 1m 23s", "Working 1m 24s", "Working 1m 25s"]) {
        act(() => vi.advanceTimersByTime(1_000));
        expect(tip()).toBe(want);
      }
      expect(commits.mock.calls.length).toBe(drawn);
    } finally {
      vi.useRealTimers();
    }
  });

  it("through useTileHandlers a tile calls the handlers the latest draw passed, keeps one function per handler across draws, and draws again when a change shows", () => {
    const first = vi.fn();
    const last = vi.fn();
    const seen: Array<() => void> = [];
    function Sidebar({ onSelect, over = {} }: { onSelect: () => void; over?: Partial<SidebarThreadSnapshot> }) {
      const handlers = useTileHandlers()("thread:th_1", { onSelect, onContextMenu: () => {}, onRename: () => {}, onRenameCancel: () => {} });
      seen.push(handlers.onSelect);
      return (
        <SidebarProvider defaultOpen>
          <ThreadTile thread={thread({ status: "completed", ...over })} place={{ ...PLACE }} model={null} time="3m" depth={0} active={false} renaming={false} saving={false} {...handlers} />
        </SidebarProvider>
      );
    }
    const view = render(<Sidebar onSelect={first} />);
    view.rerender(<Sidebar onSelect={last} />);
    expect(seen[1]).toBe(seen[0]);
    fireEvent.click(tile());
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledTimes(1);
    view.rerender(<Sidebar onSelect={last} over={{ status: "failed" }} />);
    expect(slot().dataset["threadStatus"]).toBe("failed");
  });

  it("a failed thread and one waiting on the person keep the foreground ink, whatever their session says", () => {
    for (const over of [{ status: "failed" as const }, { status: "completed" as const, asking: "Permission for Bash: pnpm install" }]) {
      mount({ over });
      expect(rows()[1]!.querySelector("[data-thread-title]")!.className, JSON.stringify(over)).toContain("text-sidebar-foreground");
      expect(rows()[1]!.querySelector("[data-thread-title]")!.className, JSON.stringify(over)).not.toContain("text-sidebar-muted-foreground");
      cleanup();
    }
  });

  it("the selected tile lifts and its title alone takes the weight", () => {
    mount({ active: true });
    expect(tile().dataset["active"]).toBe("true");
    expect(tile().className).toContain("data-[active=true]:font-normal");
    expect(rows()[1]!.querySelector("[data-thread-title]")!.className).toContain("font-medium");
    expect(rows()[0]!.className).not.toContain("font-medium");
  });

  it("selects on a click, and keeps no native hover text, the card being the one", () => {
    const onSelect = vi.fn();
    mount({ over: { asking: "Permission for Bash: pnpm install" }, onSelect });
    expect(tile().hasAttribute("title")).toBe(false);
    fireEvent.click(tile());
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe("a workspace with no thread yet", () => {
  it("is a tile of the same shape: where it runs, its name muted, no status and no agent", () => {
    render(
      <SidebarProvider defaultOpen>
        <WorkspaceTile rowId="ws:ws_a" name="pricing page" place={PLACE} checkout={{ branch: "agent/pricing-page", counts: [] }} depth={0} active={false} renaming={false} saving={false} onSelect={() => {}} onContextMenu={() => {}} onRename={() => {}} onRenameCancel={() => {}} />
      </SidebarProvider>,
    );
    expect(rows()).toHaveLength(2);
    expect(tile().dataset["rowId"]).toBe("ws:ws_a");
    expect(tile().querySelector("[data-thread-status]")).toBeNull();
    expect(tile().querySelector("[data-harness-mark]")).toBeNull();
    expect(rows()[1]!.textContent).toBe("pricing page");
    expect(rows()[1]!.querySelector("[data-thread-title]")!.className).toContain("text-sidebar-muted-foreground");
    expect(tile().textContent).not.toContain("agent/pricing-page");
  });
});

describe("a tile's acts on hover", () => {
  const settleOn = (over: Partial<SidebarThreadSnapshot>, onSettle = vi.fn(), onSelect = vi.fn()) => {
    render(
      <SidebarProvider defaultOpen>
        <ThreadTile thread={thread(over)} place={PLACE} model={null} time="3m" depth={0} active={false} renaming={false} saving={false} onSelect={onSelect} onContextMenu={() => {}} onRename={() => {}} onRenameCancel={() => {}} onSettle={onSettle} />
      </SidebarProvider>,
    );
    return { onSettle, onSelect };
  };

  it("a quiet tile's Settle stands beside its button, not in it, in the status slot's place: nothing at rest, faded in by opacity on hover, its item saying it has an act", () => {
    const { onSettle, onSelect } = settleOn({ status: "completed", endedAt: "2026-09-17T00:05:00.000Z" });
    const item = tile().parentElement!;
    expect(item.hasAttribute("data-has-action")).toBe(true);
    expect(item.className).toContain("group/menu-item");
    const settle = item.querySelector<HTMLElement>(":scope > [data-tile-settle]")!;
    expect(tile().contains(settle)).toBe(false);
    expect(settle.dataset["sidebar"]).toBe("menu-action");
    expect(settle.getAttribute("aria-label")).toBe("Settle thread");
    expect(settle.querySelector("svg.lucide-archive")).not.toBeNull();
    expect(settle.className).toContain("opacity-0");
    expect(settle.className).toContain("group-hover/menu-item:opacity-100");
    expect(settle.className).toContain("transition-opacity");
    // The slot gives the act its place on hover, and the tile's own room stays as it was.
    expect(slot().parentElement!.className).toContain("group-hover/menu-item:invisible");
    expect(tile().className).toContain("group-data-has-action/menu-item:pe-2");
    fireEvent.click(settle);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a tile's Settle says Settle on the app's tooltip once the pointer rests on it the kit's 600 ms, as the Threads bar's acts do", async () => {
    vi.useFakeTimers();
    try {
      render(
        <TooltipProvider>
          <SidebarProvider defaultOpen>
            <ThreadTile thread={thread({ status: "completed", endedAt: "2026-09-17T00:05:00.000Z" })} place={PLACE} model={null} time="3m" depth={0} active={false} renaming={false} saving={false} onSelect={() => {}} onContextMenu={() => {}} onRename={() => {}} onRenameCancel={() => {}} onSettle={() => {}} />
          </SidebarProvider>
        </TooltipProvider>,
      );
      const settle = tile().parentElement!.querySelector<HTMLElement>(":scope > [data-tile-settle]")!;
      expect(settle.hasAttribute("title")).toBe(false);
      pointAt(settle);
      expect(await tipsAfter(300)).toEqual([]);
      expect(await tipsAfter(400)).toEqual(["Settle"]);
      expect(document.querySelector("[data-tile-card]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a lead tile's fold control names what it does on the app's tooltip: Fold while the tree is open, Unfold while it is shut", async () => {
    vi.useFakeTimers();
    try {
      const draw = (fold: "open" | number) =>
        render(
          <TooltipProvider>
            <SidebarProvider defaultOpen>
              <ThreadTile thread={thread()} place={PLACE} model={null} time="3m" depth={0} active={false} renaming={false} saving={false} onSelect={() => {}} onContextMenu={() => {}} onRename={() => {}} onRenameCancel={() => {}} fold={fold} onFold={() => {}} />
            </SidebarProvider>
          </TooltipProvider>,
        );
      draw("open");
      pointAt(document.querySelector<HTMLElement>("[data-tile-fold=open]")!);
      expect(await tipsAfter(300)).toEqual([]);
      expect(await tipsAfter(400)).toEqual(["Fold"]);
      cleanup();
      draw(3);
      pointAt(document.querySelector<HTMLElement>("[data-tile-fold=shut]")!);
      expect(await tipsAfter(700)).toEqual(["Unfold"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers Settle only where the thread and everything under it is quiet: a working, waiting or asking tile, or one over a working child, offers nothing", () => {
    const node = (t: SidebarThreadSnapshot, children: TileNode[] = []): TileNode => ({ thread: { id: t.id, parentThreadId: t.parentThreadId, startedAt: t.startedAt, runs: {} as never, thread: t }, children });
    const tree = tileTree({ nowMs: Date.parse("2026-09-17T01:00:00.000Z"), settleMs: null });
    const ended = { status: "completed" as const, endedAt: "2026-09-17T00:05:00.000Z" };
    expect(settlesOnHover(node(thread(ended)), tree)).toBe(true);
    expect(settlesOnHover(node(thread({ status: "failed", endedAt: "2026-09-17T00:05:00.000Z" })), tree)).toBe(true);
    expect(settlesOnHover(node(thread()), tree)).toBe(false);
    expect(settlesOnHover(node(thread({ capped: { placeId: "p", place: "hetzner", running: 2, atOnce: 2 } })), tree)).toBe(false);
    expect(settlesOnHover(node(thread({ ...ended, asking: "Permission for Bash: ls" })), tree)).toBe(false);
    expect(settlesOnHover(node(thread(ended), [node(thread({ id: "th_2", parentThreadId: "th_1" }))]), tree)).toBe(false);
    const running: SubagentView = { id: "sa", title: "Read the map", state: "running", startedAt: 0 };
    expect(settlesOnHover(node(thread({ ...ended, subagents: [running] })), tree)).toBe(false);
    // A failed child holds nothing, as the menu's Settle reads it; one that asks or waits on the threads at once does.
    const failed = thread({ id: "th_2", parentThreadId: "th_1", status: "failed", endedAt: "2026-09-17T00:06:00.000Z" });
    expect(settlesOnHover(node(thread(ended), [node(failed)]), tree)).toBe(true);
    expect(settlesOnHover(node(thread(ended), [node(thread({ id: "th_2", parentThreadId: "th_1", ...ended, asking: "Run pnpm install" }))]), tree)).toBe(false);
    expect(settlesOnHover(node(thread(ended), [node(failed, [node(thread({ id: "th_3", parentThreadId: "th_2", capped: { placeId: "p", place: "hetzner", running: 2, atOnce: 2 } }))])]), tree)).toBe(false);
  });

  it("a running subagent's row offers Stop subagent beside it in its status's place, named on the app's tooltip, and an ended one nothing", async () => {
    const of = thread();
    const draw = (subagent: SubagentView) => {
      const leaf = { subagent, of };
      const part = subagent.state === "running" ? ("live" as const) : ("finished" as const);
      const tree = tileTree({ nowMs: Date.now(), settleMs: null });
      render(
        <TooltipProvider>
          <SidebarProvider defaultOpen>
            <SubagentRow subagent={subagent} target={childTarget(leaf, part, tree)} kind={kindOf(leaf, part)} note={undefined} depth={1} />
          </SidebarProvider>
        </TooltipProvider>,
      );
    };
    useStore.setState({ api: { interruptSession: async () => ({}) } } as never);
    draw({ id: "sa", title: "Read the map", state: "running", startedAt: Date.now() - 60_000 });
    const row = document.querySelector<HTMLElement>("[data-subagent-row]")!;
    expect(row.querySelector("svg.lucide-bot")).not.toBeNull();
    const stop = row.parentElement!.querySelector<HTMLElement>(":scope > [data-subagent-stop]")!;
    expect(stop.getAttribute("aria-label")).toBe("Stop subagent");
    expect(stop.className).toContain("opacity-0");
    expect(row.contains(stop)).toBe(false);
    vi.useFakeTimers();
    try {
      pointAt(stop);
      expect(await tipsAfter(300)).toEqual([]);
      expect(await tipsAfter(400)).toEqual(["Stop subagent"]);
    } finally {
      vi.useRealTimers();
    }
    cleanup();
    draw({ id: "sa", title: "Read the map", state: "done", startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000 });
    expect(document.querySelector("[data-subagent-stop]")).toBeNull();
    expect(document.querySelector("[data-has-action]")).toBeNull();
    useStore.setState({ api: null } as never);
  });

  it("a failed subagent's card leads with Failed and why, whole under the word", async () => {
    vi.useFakeTimers();
    try {
      const subagent: SubagentView = { id: "sa", title: "Check the CSP headers", state: "failed", startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000, failure: "WebFetch could not reach https://acme.dev: connect ETIMEDOUT" };
      const leaf = { subagent, of: thread() };
      const tree = tileTree({ nowMs: Date.now(), settleMs: null });
      render(
        <SidebarProvider defaultOpen>
          <SubagentRow subagent={subagent} target={childTarget(leaf, "finished", tree)} kind={kindOf(leaf, "finished")} note={noteOf(leaf, "finished")} depth={1} />
        </SidebarProvider>,
      );
      const row = document.querySelector<HTMLElement>("[data-subagent-row]")!;
      fireEvent.pointerEnter(row, { pointerType: "mouse" });
      fireEvent.mouseEnter(row);
      fireEvent.mouseMove(row);
      await act(async () => void vi.advanceTimersByTime(600));
      const status = document.querySelector<HTMLElement>("[data-subagent-card] [data-status-line]")!;
      expect(status.dataset["statusLine"]).toBe("failed");
      expect(status.querySelector("[data-status-reason]")!.textContent).toBe("WebFetch could not reach https://acme.dev: connect ETIMEDOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a subagent's card names its model in the words its page's bar says, off the agent's catalog, and the id where the catalog has none", async () => {
    vi.useFakeTimers();
    const catalog = { harness: "claude", label: "Claude Code", source: "table" as const, version: null, models: [{ value: "claude-opus-5-5", label: "Opus 5.5" }], efforts: [], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false };
    const modelOn = async (model: string): Promise<string> => {
      const subagent: SubagentView = { id: "sa", title: "Read the open tickets", state: "running", startedAt: Date.now() - 60_000, model };
      const leaf = { subagent, of: thread() };
      const tree = tileTree({ nowMs: Date.now(), settleMs: null });
      render(
        <SidebarProvider defaultOpen>
          <SubagentRow subagent={subagent} target={childTarget(leaf, "live", tree)} kind={kindOf(leaf, "live")} note={noteOf(leaf, "live")} depth={1} lead={{ workspaceId: "ws_a", threadId: "th_1" }} />
        </SidebarProvider>,
      );
      pointAt(document.querySelector<HTMLElement>("[data-subagent-row]")!);
      await act(async () => void vi.advanceTimersByTime(600));
      const words = document.querySelector('[data-subagent-card] [data-tile-card-line="agent"]')!.textContent!;
      cleanup();
      return words;
    };
    try {
      useStore.setState({ harnesses: [catalog] } as never);
      expect(await modelOn("claude-opus-5-5")).toBe("Opus 5.5");
      expect(await modelOn("claude-opus-5-5[1m]")).toBe("Opus 5.5");
      expect(await modelOn("claude-haiku-9")).toBe("claude-haiku-9");
    } finally {
      useStore.setState({ harnesses: [] } as never);
      vi.useRealTimers();
    }
  });
});
