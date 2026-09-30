// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { threadIndicator } from "../adapt/index.js";
import { SidebarProvider } from "../components/ui/sidebar.js";
import { ThreadTile, WorkspaceTile, type TilePlace } from "./ThreadTile.js";
import type { LinkDown } from "../terminal/paneWords.js";
import type { TileCheckout } from "./tileCheckout.js";
import type { PlaceView } from "@wsp/protocol";

const thread = (over: Partial<SidebarThreadSnapshot> = {}): SidebarThreadSnapshot => {
  const base = { id: "th_1", threadId: "th_1", sessionId: "s_1", workspaceId: "ws_a", title: "Cart total rounding", status: "running" as const, ran: true, startedAt: "2026-09-17T00:00:00.000Z", endedAt: null, harness: "claude", startedBy: "person" as const, project: "spoo", parentThreadId: null, attempt: null, model: null, asking: null, costUsd: null, unread: false, readAt: null, settledAt: null, needsYou: false, pinnedAt: null, snoozedUntil: null, section: null };
  const merged = { ...base, ...over };
  return { ...merged, indicator: threadIndicator({ status: merged.status, ...(merged.asking === null ? {} : { asking: merged.asking }) }) };
};

const HERE: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", mac: "macbook", default: true, present: true, takesForks: false, engine: "none", shape: { cpu: 8, memMb: 16384 }, diskFreeBytes: 210 * 1024 ** 3 };
const PLACE: TilePlace = { projectId: "pr_1", project: "spoo-landing", computer: "zingzy's MacBook Pro", at: HERE };

function mount({ over = {}, checkout = { branch: "fix/cart-rounding", counts: [] }, active = false, settled = false, snoozedWorking, linkDown, onSelect = () => {} }: { over?: Partial<SidebarThreadSnapshot>; checkout?: TileCheckout; active?: boolean; settled?: boolean; snoozedWorking?: number; linkDown?: LinkDown; onSelect?: () => void } = {}) {
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
        {...(linkDown === undefined ? {} : { linkDown })}
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

describe("a thread tile", () => {
  const DOWN: LinkDown = { word: "Reconnecting", sentence: "Reconnecting to zingzy's MacBook Pro" };

  it("a resting tile whose workspace's link is down says so in its slot, one quiet word with the sentence on its hover", () => {
    mount({ over: { status: "completed", endedAt: "2026-09-17T00:05:00.000Z" }, linkDown: DOWN });
    expect(slot().textContent).toBe("Reconnecting");
    expect(slot().getAttribute("title")).toBe(DOWN.sentence);
    expect(slot().dataset["tone"]).toBeUndefined();
    expect([...slot().classList].filter(c => c.startsWith("text-status-"))).toEqual([]);
  });

  it("a thread that is working or waits on the person keeps its own status over a link that is down", () => {
    mount({ over: { status: "running" }, linkDown: DOWN });
    expect(slot().textContent).not.toContain("Reconnecting");
    cleanup();
    mount({ over: { status: "failed", endedAt: "2026-09-17T00:05:00.000Z" }, linkDown: DOWN });
    expect(slot().textContent).toContain("Failed");
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
    expect(slot().textContent).toBe("Done");
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
    expect(slot().textContent).toBe("Failed");
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

  it("walks the crab at row two's right end while working, never in the status slot, and the slot holds the elapsed time", () => {
    mount();
    expect(rows()[1]!.lastElementChild!.matches("canvas[data-crab]")).toBe(true);
    expect(slot().querySelector("canvas")).toBeNull();
    expect(slot().dataset["tone"]).toBe("working");
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
        ["note", "Permission for Bash: pnpm install"],
      ]);
      // The computer's icon is the registry's, the one the Computers page draws for this Mac.
      expect(card.querySelector('[data-tile-card-line="computer"] [data-computer-glyph]')?.getAttribute("data-computer-glyph")).toBe("laptop");
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
