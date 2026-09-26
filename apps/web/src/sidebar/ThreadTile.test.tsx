// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { threadIndicator } from "../adapt/index.js";
import { SidebarProvider } from "../components/ui/sidebar.js";
import { ThreadTile, WorkspaceTile, type TilePlace } from "./ThreadTile.js";

const thread = (over: Partial<SidebarThreadSnapshot> = {}): SidebarThreadSnapshot => {
  const base = { id: "th_1", threadId: "th_1", sessionId: "s_1", workspaceId: "ws_a", title: "Cart total rounding", status: "running" as const, ran: true, startedAt: "2026-09-17T00:00:00.000Z", endedAt: null, harness: "claude", startedBy: "person" as const, project: "spoo", parentThreadId: null, asking: null, costUsd: null };
  const merged = { ...base, ...over };
  return { ...merged, indicator: threadIndicator({ status: merged.status, ...(merged.asking === null ? {} : { asking: merged.asking }) }) };
};

const PLACE: TilePlace = { projectId: "pr_1", project: "spoo-landing", computer: "zingzy's MacBook Pro" };

function mount({ over = {}, branch = "fix/cart-rounding", active = false, onSelect = () => {} }: { over?: Partial<SidebarThreadSnapshot>; branch?: string; active?: boolean; onSelect?: () => void } = {}) {
  return render(
    <SidebarProvider defaultOpen>
      <ThreadTile
        thread={thread(over)}
        place={PLACE}
        branch={branch}
        time="3m"
        depth={1}
        active={active}
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
  it("is three rows: where it runs with the status at the right, the title, then the agent's mark and the branch", () => {
    mount({ over: { status: "failed" } });
    expect(rows()).toHaveLength(3);
    const [one, two, three] = rows();
    expect(one!.querySelector("svg")).not.toBeNull();
    expect(one!.querySelector("[data-tile-where]")!.textContent).toBe("spoo-landing @ zingzy's MacBook Pro");
    expect(one!.lastElementChild).toBe(slot());
    expect(slot().textContent).toBe("Failed");
    expect(two!.textContent).toBe("Cart total rounding");
    expect(two!.hasAttribute("data-thread-title")).toBe(true);
    expect(three!.querySelector("[data-harness-mark=claude]")).not.toBeNull();
    expect(three!.querySelector(".lucide-git-branch")).not.toBeNull();
    expect(three!.querySelector("[data-tile-branch]")!.textContent).toBe("fix/cart-rounding");
    expect(tile().textContent).not.toMatch(/[·•]/);
  });

  it("draws the tile at its sizes: 68 px, rows of 14, 18 and 14 with 3 px between, rows one and three at 11 px", () => {
    mount();
    expect(tile().className).toContain("h-[68px]");
    expect(tile().className).toContain("gap-[3px]");
    expect(tile().className).toContain("p-2");
    const [one, two, three] = rows();
    expect(one!.className).toContain("h-3.5");
    expect(one!.className).toContain("text-[11px]");
    expect(two!.className).toContain("h-[18px]");
    expect(two!.className).toContain("text-sm");
    expect(three!.className).toContain("h-3.5");
    expect(three!.className).toContain("text-[11px]");
  });

  it("walks the crab at row three's right end while working, never in the status slot, and the slot holds the elapsed time", () => {
    mount();
    const three = rows()[2]!;
    expect(three.lastElementChild!.matches("canvas[data-crab]")).toBe(true);
    expect(slot().querySelector("canvas")).toBeNull();
    expect(slot().dataset["tone"]).toBe("working");
    cleanup();
    for (const over of [{ status: "failed" as const }, { status: "completed" as const }, { asking: "Write out.txt" }]) {
      mount({ over });
      expect(tile().querySelector("canvas"), JSON.stringify(over)).toBeNull();
      cleanup();
    }
  });

  it("a copy with no branch shows the agent's mark alone on row three", () => {
    mount({ branch: "" });
    const three = rows()[2]!;
    expect(three.querySelector("[data-harness-mark=claude]")).not.toBeNull();
    expect(three.querySelector(".lucide-git-branch")).toBeNull();
    expect(three.querySelector("[data-tile-branch]")).toBeNull();
  });

  it("a resting thread's title takes the muted ink and its slot the age; a working one's the foreground", () => {
    mount({ over: { status: "completed" } });
    expect(rows()[1]!.className).toContain("text-sidebar-muted-foreground");
    expect(slot().textContent).toBe("3m");
    cleanup();
    mount();
    expect(rows()[1]!.className).toContain("text-sidebar-foreground");
  });

  it("the selected tile lifts and its title alone takes the weight", () => {
    mount({ active: true });
    expect(tile().dataset["active"]).toBe("true");
    expect(tile().className).toContain("data-[active=true]:font-normal");
    expect(rows()[1]!.className).toContain("font-medium");
    expect(rows()[0]!.className).not.toContain("font-medium");
  });

  it("carries the title, where it runs, the agent and the question it waits on in its hover text, and selects on a click", () => {
    const onSelect = vi.fn();
    mount({ over: { asking: "Permission for Bash: pnpm install" }, onSelect });
    expect(tile().getAttribute("title")).toBe("Cart total rounding\nspoo-landing @ zingzy's MacBook Pro\nClaude Code\nPermission for Bash: pnpm install");
    fireEvent.click(tile());
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe("a workspace with no thread yet", () => {
  it("is a tile of the same shape: where it runs, its name muted, no status and no agent", () => {
    render(
      <SidebarProvider defaultOpen>
        <WorkspaceTile rowId="ws:ws_a" name="pricing page" place={PLACE} branch="agent/pricing-page" depth={0} active={false} renaming={false} saving={false} onSelect={() => {}} onContextMenu={() => {}} onRename={() => {}} onRenameCancel={() => {}} />
      </SidebarProvider>,
    );
    expect(rows()).toHaveLength(3);
    expect(tile().dataset["rowId"]).toBe("ws:ws_a");
    expect(tile().querySelector("[data-thread-status]")).toBeNull();
    expect(tile().querySelector("[data-harness-mark]")).toBeNull();
    expect(rows()[1]!.textContent).toBe("pricing page");
    expect(rows()[1]!.className).toContain("text-sidebar-muted-foreground");
    expect(rows()[2]!.querySelector("[data-tile-branch]")!.textContent).toBe("agent/pricing-page");
  });
});
