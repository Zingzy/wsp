// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's pure logic: the copied t3code sort, search, traversal and
// pill rollup over wsp thread snapshots, plus our row labels and the
// new-workspace helpers.
import { describe, expect, it } from "vitest";
import type { WorkspaceStatus } from "@wsp/protocol";
import { RequestError } from "../src/protocol/client.js";
import { explainCreateRefusal } from "../src/protocol/store.js";
import {
  isThreadWorking,
  resolveAdjacentThreadId,
  searchSidebarThreadsByTitle,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
} from "../src/sidebar/Sidebar.logic.js";
import {
  compactTimeLabel,
  costLabel,
  defaultWorkspaceName,
  idleCountdownLabel,
  dotClassForTone,
  threadPill,
  textClassForTone,
  reachNote,
} from "../src/sidebar/workspaceRows.js";
import { formatRelativeTimeLabel } from "../src/lib/timestampFormat.js";

const thread = (id: string, startedAt: string | null, endedAt: string | null = null) => ({ id, title: id, startedAt, endedAt });

describe("copied sort and search", () => {
  it("active threads sort newest start first, id as the tiebreak", () => {
    const sorted = sortThreadsForSidebar([
      thread("b", "2026-09-01T00:01:00Z"),
      thread("a", "2026-09-01T00:02:00Z"),
      thread("c", "2026-09-01T00:01:00Z"),
      thread("d", null),
    ]);
    expect(sorted.map(t => t.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("settled threads sort by when they ended, falling back to when they started", () => {
    const sorted = sortSettledThreadsForSidebar([
      thread("old", "2026-09-01T00:00:00Z", "2026-09-01T00:05:00Z"),
      thread("new", "2026-09-01T00:00:00Z", "2026-09-01T00:09:00Z"),
      thread("unstamped", "2026-09-01T00:07:00Z"),
    ]);
    expect(sorted.map(t => t.id)).toEqual(["new", "unstamped", "old"]);
  });

  it("title search is case-insensitive and keeps the input order; an empty query matches nothing", () => {
    const threads = [{ title: "Fix the port list" }, { title: "upgrade node" }, { title: "port forwarding" }];
    expect(searchSidebarThreadsByTitle(threads, "PORT").map(t => t.title)).toEqual(["Fix the port list", "port forwarding"]);
    expect(searchSidebarThreadsByTitle(threads, "  ")).toEqual([]);
  });
});

describe("copied traversal and rollup", () => {
  it("walks the row ids and stops at the ends", () => {
    const ids = ["a", "b", "c"];
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: null, direction: "next" })).toBe("a");
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: null, direction: "previous" })).toBe("c");
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: "a", direction: "next" })).toBe("b");
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: "c", direction: "next" })).toBeNull();
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: "zz", direction: "next" })).toBeNull();
  });

  it("only a running turn is working; a thread waiting on the user is idle whatever its session says", () => {
    expect(isThreadWorking({ status: "running" })).toBe(true);
    expect(isThreadWorking({ status: "completed" })).toBe(false);
    expect(isThreadWorking({ status: "interrupted" })).toBe(false);
    expect(isThreadWorking({ status: "failed" })).toBe(false);
    expect(isThreadWorking({ status: "running", hasPendingApprovals: true })).toBe(false);
    expect(isThreadWorking({ status: "running", hasPendingUserInput: true })).toBe(false);
  });
});

const status = (over: Partial<WorkspaceStatus>): WorkspaceStatus => ({
  id: "ws_a", name: "api", machineId: "m1", phase: "running", golden: "snap", createdAt: "2026-09-01T00:00:00Z",
  machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11, ...over,
});

describe("workspace row labels", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");

  it("idle countdown: minutes until the nap, soon under a minute, active when nothing is scheduled", () => {
    expect(idleCountdownLabel(status({ idleAt: now + 14.5 * 60_000 }), now)).toBe("naps in 14m");
    expect(idleCountdownLabel(status({ idleAt: now + 90 * 60_000 }), now)).toBe("naps in 1h 30m");
    expect(idleCountdownLabel(status({ idleAt: now + 20_000 }), now)).toBe("naps soon");
    expect(idleCountdownLabel(status({ idleAt: now - 5_000 }), now)).toBe("naps soon");
    expect(idleCountdownLabel(status({}), now)).toBe("active");
  });

  it("no countdown off the running phase, on a machine the provider lost, or without a status", () => {
    expect(idleCountdownLabel(status({ phase: "napping", idleAt: now + 60_000 }), now)).toBeNull();
    expect(idleCountdownLabel(status({ phase: "waking" }), now)).toBeNull();
    expect(idleCountdownLabel(status({ machineState: "gone", reach: { state: "gone" }, idleAt: now + 17 * 60_000 }), now)).toBeNull();
    expect(idleCountdownLabel(status({ machineState: "gone", reach: { state: "gone" } }), now)).toBeNull();
    expect(idleCountdownLabel(null, now)).toBeNull();
  });

  it("reach slow reads as edge slow; every other reach state is carried by the indicator", () => {
    expect(reachNote("slow")).toBe("edge slow");
    expect(reachNote("reachable")).toBeNull();
    expect(reachNote("zombie")).toBeNull();
    expect(reachNote(null)).toBeNull();
  });

  it("cost: rate while the machine is up (running or unreachable), never on a paused or gone one, accrued always, nothing before the first tick", () => {
    expect(costLabel({ state: "running", rateUsdPerHour: 0.11, accruedUsd: 0.0037 })).toBe("$0.110/hr · $0.0037 today");
    expect(costLabel({ state: "unreachable", rateUsdPerHour: 0.11, accruedUsd: 0.0037 })).toBe("$0.110/hr · $0.0037 today");
    expect(costLabel({ state: "paused", rateUsdPerHour: 0.11, accruedUsd: 0.0037 })).toBe("$0.0037 today");
    expect(costLabel({ state: "gone", rateUsdPerHour: 0.11, accruedUsd: 0.0037 })).toBe("$0.0037 today");
    expect(costLabel({ state: "running", rateUsdPerHour: 0.11, accruedUsd: null })).toBe("$0.110/hr");
    expect(costLabel({ state: "paused", rateUsdPerHour: null, accruedUsd: null })).toBeNull();
  });

  it("thread pills key on the session status, wear the adapter's word, and use tokens: only running is the success colour", () => {
    expect(threadPill({ status: "running", indicator: { label: "Working", tone: "neutral", pulse: true } })).toMatchObject({ label: "Working", pulse: true, dotClass: expect.stringContaining("muted-foreground") });
    expect(threadPill({ status: "failed", indicator: { label: "Ended", tone: "neutral", pulse: false } })).toMatchObject({ label: "Ended", dotClass: expect.stringContaining("muted-foreground") });
    expect(threadPill({ status: "failed", indicator: { label: "Stopped short", tone: "neutral", pulse: false } })).toMatchObject({ label: "Stopped short" });
    expect(threadPill({ status: "completed", indicator: { label: "Idle", tone: "neutral", pulse: false } })).toBeNull();
    expect(threadPill({ status: "interrupted", indicator: { label: "Idle", tone: "neutral", pulse: false } })).toBeNull();
    expect(threadPill({ status: "running", indicator: null })).toBeNull();
    for (const cls of [dotClassForTone("running"), textClassForTone("running")]) expect(cls).toContain("success");
    for (const cls of [dotClassForTone("paused"), dotClassForTone("neutral"), textClassForTone("paused"), textClassForTone("neutral")]) expect(cls).toContain("muted-foreground");
    for (const cls of [dotClassForTone("running"), dotClassForTone("paused"), dotClassForTone("neutral"), textClassForTone("running"), textClassForTone("neutral")]) {
      expect(cls).not.toMatch(/emerald|zinc|sky|red/);
    }
  });

  it("relative time: t3code's label, compacted for the row", () => {
    const threeMinutesAgo = new Date(Date.now() - 3 * 60_000).toISOString();
    expect(formatRelativeTimeLabel(threeMinutesAgo)).toBe("3m ago");
    expect(compactTimeLabel(threeMinutesAgo)).toBe("3m");
    expect(compactTimeLabel(new Date().toISOString())).toBe("now");
    expect(compactTimeLabel(null)).toBe("");
  });
});

describe("new workspace helpers", () => {
  it("default name is the first free workspace-n", () => {
    expect(defaultWorkspaceName([])).toBe("workspace-1");
    expect(defaultWorkspaceName(["workspace-1"])).toBe("workspace-2");
    expect(defaultWorkspaceName(["workspace-2", "api"])).toBe("workspace-1");
    expect(defaultWorkspaceName(["workspace-1", "workspace-2"])).toBe("workspace-3");
  });

  it("a concurrency refusal keeps the runtime's words, which name the machines holding the slots, under the cap title", () => {
    const line = "both machine slots are in use: first, t-cap. Pause one or wait for a nap.";
    const explained = explainCreateRefusal(new RequestError(line, "concurrency"));
    expect(explained.title).toMatch(/machine cap/i);
    expect(explained.detail).toBe(line);
  });

  it("other failures keep their message under a plain title", () => {
    expect(explainCreateRefusal(new Error("no golden image yet"))).toEqual({
      title: "Could not create the workspace",
      detail: "no golden image yet",
    });
    expect(explainCreateRefusal("boom").detail).toBe("boom");
  });
});
