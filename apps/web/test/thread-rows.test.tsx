// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarThreadSnapshot } from "../src/adapt/index.js";
import { ThreadRows } from "../src/components/threads/ThreadRows.js";
import { useStore } from "../src/protocol/store.js";

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
  asking: null,
  costUsd: null,
  ...over,
});

const ROWS = [
  { thread: thread("Cart total rounding", { status: "running", startedAt: "2026-09-26T11:46:00Z", endedAt: null }), place: "Solari" },
  { thread: thread("Coupon expiry test"), place: "Solari" },
  { thread: thread("Address form race", { harness: "codex", asking: "Bash: pnpm install" }), place: "zingzy's MacBook Pro" },
  { thread: thread("Checkout end to end on Firefox", { status: "failed" }), place: "spoo" },
];

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-thread-row]")];

describe("ThreadRows", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("heads the list with its label in the small caps and draws one 36px line per thread", () => {
    render(<ThreadRows label="Threads" rows={ROWS} />);
    const head = document.querySelector<HTMLElement>("[data-thread-rows-head]")!;
    expect(head.textContent).toBe("Threads");
    expect(head.className).toContain("uppercase");
    expect(head.className).toContain("h-8");
    expect(rows()).toHaveLength(4);
    for (const row of rows()) expect(row.className).toContain("h-9");
  });

  it("each line is the agent's mark, the title as the way to the thread, the place in muted sans and the status slot", () => {
    render(<ThreadRows label="Threads" rows={ROWS} />);
    const [working, resting, asking, failed] = rows();
    expect(working!.querySelector("[data-harness-mark]")).not.toBeNull();
    expect(asking!.querySelector<SVGElement>("[data-harness-mark]")!.dataset.harnessMark).toBe("codex");
    const link = working!.querySelector("a")!;
    expect(link.textContent).toBe("Cart total rounding");
    const place = working!.querySelector<HTMLElement>("[data-thread-place]")!;
    expect(place.textContent).toBe("Solari");
    expect(place.className).toContain("text-xs");
    expect(place.className).toContain("text-muted-foreground");
    expect(place.className).not.toContain("font-mono");
    expect(asking!.querySelector("[data-thread-place]")!.textContent).toBe("zingzy's MacBook Pro");
    const status = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-thread-status]")!;
    expect(rows().map(row => status(row).dataset.threadStatus)).toEqual(["working", "resting", "needs-you", "failed"]);
    for (const row of rows()) expect(status(row).className).toContain("w-22");
    expect(status(working!).querySelector("[data-crab]")).not.toBeNull();
    expect(status(working!).textContent).toContain("14m");
    expect(status(resting!).textContent).toBe("14m");
    expect(status(failed!).textContent).toBe("Failed");
  });

  it("joins nothing: no dot, no rule between the lines", () => {
    render(<ThreadRows label="Threads" rows={ROWS} />);
    const list = document.querySelector<HTMLElement>("[data-thread-rows]")!;
    expect(list.textContent).not.toContain("·");
    expect(list.querySelector(".bg-border, hr")).toBeNull();
  });

  it("leaves the place out where the caller has no name for it", () => {
    render(<ThreadRows label="Threads" rows={[{ thread: thread("Local"), place: "" }]} />);
    expect(document.querySelector("[data-thread-place]")).toBeNull();
  });

  it("a click on the title opens that thread", () => {
    const select = vi.fn();
    useStore.setState({ select } as never);
    render(<ThreadRows label="Threads" rows={ROWS} />);
    fireEvent.click(rows()[1]!.querySelector("a")!);
    expect(select).toHaveBeenCalledWith("ws_api", "thr_Coupon expiry test");
  });
});
