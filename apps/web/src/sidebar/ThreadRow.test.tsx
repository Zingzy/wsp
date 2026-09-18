// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { threadIndicator } from "../adapt/index.js";
import { SidebarProvider } from "../components/ui/sidebar.js";
import { ThreadRow } from "./ThreadRow.js";

const thread = (over: Partial<SidebarThreadSnapshot> = {}): SidebarThreadSnapshot => {
  const base = { id: "th_1", threadId: "th_1", sessionId: "s_1", workspaceId: "ws_a", title: "fix the port list", status: "running" as const, ran: true, startedAt: "2026-09-17T00:00:00.000Z", endedAt: null, harness: "claude", startedBy: "person" as const, project: "spoo", parentThreadId: null, asking: null, costUsd: null };
  const merged = { ...base, ...over };
  return { ...merged, indicator: threadIndicator({ status: merged.status, ...(merged.asking === null ? {} : { asking: merged.asking }) }) };
};

function mount(over: Partial<SidebarThreadSnapshot> = {}) {
  return render(
    <SidebarProvider defaultOpen>
      <ThreadRow
        thread={thread(over)}
        time="3m"
        runs={{ workspace: "pricing page", where: "this Mac" }}
        under="pricing page"
        active={false}
        renaming={false}
        saving={false}
        onSelect={() => {}}
        onContextMenu={() => {}}
        onRename={() => {}}
        onRenameCancel={() => {}}
      />
    </SidebarProvider>,
  );
}

const state = (): string | null => document.querySelector("[data-thread-state]")?.textContent ?? null;
/** Any dot the row might draw: a round span, which is what a status dot was. */
const dots = (): number => document.querySelectorAll("[data-thread-meta] .rounded-full, [data-thread-meta] [class*=animate-status]").length;

afterEach(cleanup);

describe("a thread row's state", () => {
  it("is one muted mono word and no dot, whatever the state", () => {
    mount();
    expect(state()).toBe("Working");
    expect(dots()).toBe(0);
    cleanup();
    mount({ asking: "Write out.txt in root (2 B)" });
    expect(state()).toBe("Needs you");
    expect(dots()).toBe(0);
    cleanup();
    mount({ status: "failed" });
    expect(state()).toBe("Failed");
    expect(dots()).toBe(0);
  });

  it("says nothing at all on a settled thread: a row nobody is waiting on is what every other row is", () => {
    mount({ status: "completed" });
    expect(state()).toBeNull();
    expect(dots()).toBe(0);
  });

  it("says nothing on a working row an agent opened, whose indent and opener say it already", () => {
    mount({ parentThreadId: "th_lead" });
    expect(state()).toBeNull();
    // Its own words are still there: the workspace it runs in is dropped where it is the row above's, so where.
    expect(document.querySelector("[data-thread-meta]")!.textContent).toContain("this Mac");
  });

  it("carries the agent and its words in the row's own hover text, so a reader is given the line a person sees", () => {
    mount();
    expect(screen.getByLabelText("Claude Code · spoo · you")).toBeDefined();
  });
});
