// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's pure logic: the copied t3code sort, search, traversal and
// pill rollup over wsp thread snapshots, plus our row labels and the
// new-workspace helpers.
import { describe, expect, it } from "vitest";
import { MACHINE_OS_WORD, OVER_SSH, THREAD_ARCHIVE_MS, kindWords, workspaceState, type ReachState, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { RequestError } from "../src/protocol/client.js";
import { explainCreateRefusal } from "../src/protocol/store.js";
import {
  foldArchivedThreads,
  isThreadArchived,
  isThreadWorking,
  resolveAdjacentThreadId,
  searchSidebarThreadsByTitle,
  sidebarThreadOrder,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
  splitSidebarThreads,
  topSidebarThread,
} from "../src/sidebar/Sidebar.logic.js";
import { spaceWorkspaceId } from "../src/sidebar/sidebarMode.js";
import {
  compactTimeLabel,
  defaultWorkspaceName,
  machineLine,
  spaceHeaderLines,
  idleCountdownLabel,
  dotClassForTone,
  stateSlotWord,
  threadPill,
  reachNote,
  daemonGoneLine,
  workspaceMetaLine,
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

describe("the archive fold", () => {
  const NOW = Date.parse("2026-09-08T12:00:00Z");
  const idleFor = (id: string, ms: number) => thread(id, new Date(NOW - ms - 60_000).toISOString(), new Date(NOW - ms).toISOString());

  it("the threshold is the protocol's one word: a thread idle just under it stays on the shelf, one idle at it or past it archives", () => {
    expect(isThreadArchived(idleFor("just-under", THREAD_ARCHIVE_MS - 60_000), NOW)).toBe(false);
    expect(isThreadArchived(idleFor("exactly", THREAD_ARCHIVE_MS), NOW)).toBe(true);
    expect(isThreadArchived(idleFor("well-past", 3 * THREAD_ARCHIVE_MS), NOW)).toBe(true);
  });

  it("a thread with no readable timestamp has no idleness to measure, so it stays on the shelf", () => {
    expect(isThreadArchived(thread("blank", null, null), NOW)).toBe(false);
    expect(isThreadArchived(thread("malformed", "not a date", "also not a date"), NOW)).toBe(false);
  });

  it("the fold counts each side and keeps the order the shelf sorted them into", () => {
    const shelf = [idleFor("a", 60_000), idleFor("b", 2 * THREAD_ARCHIVE_MS), idleFor("c", 3 * 60_000), idleFor("d", 5 * THREAD_ARCHIVE_MS)];
    const { settled, archived } = foldArchivedThreads(shelf, NOW);
    expect(settled.map(t => t.id)).toEqual(["a", "c"]);
    expect(archived.map(t => t.id)).toEqual(["b", "d"]);
  });

  it("a thread that takes a new turn leaves the archive on its own: it is working, so the split never offers it to the fold", () => {
    const woken = { ...idleFor("woken", 5 * THREAD_ARCHIVE_MS), status: "running" as const };
    const stale = { ...idleFor("stale", 5 * THREAD_ARCHIVE_MS), status: "completed" as const };
    const { active, settled } = splitSidebarThreads([woken, stale]);
    expect(active.map(t => t.id)).toEqual(["woken"]);
    expect(foldArchivedThreads(settled, NOW).archived.map(t => t.id)).toEqual(["stale"]);
    // And once that turn settles, its fresh end stamp keeps it out of the archive with no flag to clear.
    const replied = { ...woken, status: "completed" as const, endedAt: new Date(NOW - 1_000).toISOString() };
    expect(isThreadArchived(replied, NOW)).toBe(false);
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

  /** A project as the adapter folds it from a status, with the record's phase behind it. */
  const project = (over: Partial<WorkspaceStatus>, view: Partial<WorkspaceView> = {}) => {
    const st = status(over);
    return { state: workspaceState({ phase: st.phase, machineState: st.machineState, reach: st.reach.state }), status: st, reach: st.reach.state, workspace: { ...st, ...view } };
  };
  const tick = (accruedUsd: number, rateUsdPerHour = 0.11) => ({ rateUsdPerHour, accruedUsd });

  it("the meta line: what it cost today first, in cents, the rate while the machine is up (running or unreachable), the edge note, the nap countdown last; the cost leads before the first tick too, as an honest zero", () => {
    const meta = (over: Partial<WorkspaceStatus>, cost: ReturnType<typeof tick> | null) => workspaceMetaLine({ project: project(over), cost, outOfMemory: undefined, nowMs: now });
    expect(meta({ idleAt: now + 14.5 * 60_000, reach: { state: "slow" } }, tick(0.0037))).toBe("$0.00 today · $0.110/hr · edge slow · naps in 14m");
    expect(meta({ idleAt: now + 14.5 * 60_000 }, tick(0.29))).toBe("$0.29 today · $0.110/hr · naps in 14m");
    expect(meta({ reach: { state: "unreachable" } }, tick(1.235))).toBe("$1.24 today · $0.110/hr · active");
    expect(meta({ phase: "napping", machineState: "paused", reach: { state: "napping" }, idleAt: now + 60_000 }, tick(0.18, 0))).toBe("$0.18 today");
    expect(meta({ machineState: "gone", reach: { state: "gone" }, idleAt: now + 60_000 }, tick(0.18))).toBe("$0.18 today");
    expect(meta({}, null)).toBe("$0.00 today · $0.110/hr · active");
    expect(meta({ phase: "napping", machineState: "paused", reach: { state: "napping" } }, null)).toBe("$0.00 today");
    // The tick's rate leads the size's: a resize is priced from the meter, not the status.
    expect(meta({}, tick(0.5, 0.15))).toBe("$0.50 today · $0.150/hr · active");
  });

  it("what the runtime is doing to the machine's helper, or a drop with memory near full, takes the whole line", () => {
    const GiB = 1024 ** 3;
    expect(workspaceMetaLine({ project: project({ idleAt: now + 60_000, daemonNote: "updating the helper" }), cost: tick(0.5), outOfMemory: undefined, nowMs: now })).toBe("updating the helper");
    expect(workspaceMetaLine({ project: project({ idleAt: now + 60_000 }), cost: tick(0.5), outOfMemory: { used: 3.59 * GiB, total: 3.94 * GiB, load1: 6.4 }, nowMs: now })).toBe("out of memory, 3.6 of 3.9 GB");
    // Before a status arrives the record's own note is the line; a status without one says nothing about the helper.
    expect(workspaceMetaLine({ project: { ...project({}), status: null }, cost: null, outOfMemory: undefined, nowMs: now })).toBe("$0.00 today");
    expect(workspaceMetaLine({ project: { ...project({}, { daemonNote: "updating the helper" }), status: null }, cost: null, outOfMemory: undefined, nowMs: now })).toBe("updating the helper");
    expect(workspaceMetaLine({ project: project({}, { daemonNote: "updating the helper" }), cost: null, outOfMemory: undefined, nowMs: now })).toBe("$0.00 today · $0.110/hr · active");
  });

  it("the state slot says nothing while running, since the dot says it, and the state's word otherwise", () => {
    const slot = (state: WorkspaceState, label: string, tone: "running" | "paused" | "neutral", pulse = false) =>
      stateSlotWord({ state, indicator: { label, tone, pulse }, workspace: project({}).workspace });
    expect(slot("running", "Running", "running")).toBe("");
    expect(slot("paused", "Paused", "paused")).toBe("Paused");
    expect(slot("gone", "Gone", "neutral")).toBe("Gone");
    expect(slot("waking", "Waking", "neutral", true)).toBe("Waking");
  });

  it("one machine line for the row and the Spaces header: the kind's words where it has them, else the size and the OS word, nothing before a status", () => {
    expect(machineLine(project({}, { kind: "local" }))).toBe("this computer");
    expect(machineLine(project({}))).toBe(`2 vCPU · 4 GB · ${MACHINE_OS_WORD}`);
    expect(machineLine({ status: null, workspace: project({}).workspace })).toBeNull();
    // A kind with its own words says them before any status has arrived, since no size is behind them.
    expect(machineLine({ status: null, workspace: { ...project({}).workspace, kind: "local" } })).toBe("this computer");
  });

  it("the Spaces header of a machine wsp does not drive is its machine words alone: no cost line, no rate, no nap line", () => {
    const header = (over: Partial<WorkspaceStatus>, view: Partial<WorkspaceView> = {}, meter: ReturnType<typeof tick> | null = null) =>
      spaceHeaderLines({ project: project(over, view), cost: meter, outOfMemory: undefined, nowMs: now });
    expect(header({ idleAt: now + 14.5 * 60_000 }, { kind: "local" }, tick(0.29))).toEqual(["this computer"]);
    // Nothing the machine bills for reaches it, whatever the meter has ticked or the runtime has scheduled.
    expect(header({}, { kind: "local" })).toEqual(["this computer"]);
    // A fork's header is untouched: the size and the OS word, the spend with its rate, the countdown when one is set.
    expect(header({ idleAt: now + 14.5 * 60_000 }, {}, tick(0.29))).toEqual([`2 vCPU · 4 GB · ${MACHINE_OS_WORD}`, "$0.29 today · $0.110/hr", "naps in 14m"]);
    expect(header({})).toEqual([`2 vCPU · 4 GB · ${MACHINE_OS_WORD}`, "$0.00 today · $0.110/hr"]);
    // What the runtime is doing to the daemon still leads on both kinds: it is the one thing there a person waits on.
    expect(header({ daemonNote: "updating the helper" }, { kind: "local" })).toEqual(["updating the helper", "this computer"]);
  });

  it("this computer's row says what it is and nothing about spend, naps or state: it runs while the host does", () => {
    const local = project({}, { kind: "local" });
    expect(workspaceMetaLine({ project: local, cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toBe("this computer");
    expect(workspaceMetaLine({ project: project({ idleAt: now + 14.5 * 60_000 }, { kind: "local" }), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toBe("this computer");
    expect(stateSlotWord({ ...local, indicator: { label: "Unreachable", tone: "neutral", pulse: false } })).toBe("");
    // What the runtime is doing to its daemon still takes the line: it is the one thing there a person waits on.
    expect(workspaceMetaLine({ project: project({ daemonNote: "updating the helper" }, { kind: "local" }), cost: null, outOfMemory: undefined, nowMs: now })).toBe("updating the helper");
  });

  it("a row says its daemon is gone on the meta line, whatever kind of machine it is", () => {
    const local = (reach: ReachState) => project({ reach: { state: reach } }, { kind: "local" });
    const line = (reach: ReachState) => workspaceMetaLine({ project: local(reach), cost: tick(0.29), outOfMemory: undefined, nowMs: now });
    // The two are different facts: nothing answering on the port, and no daemon road at all.
    expect(line("no-daemon")).toBe("no daemon answering");
    expect(line("unsupported")).toBe("no daemon on this machine");
    expect(line("reachable")).toBe("this computer");
    // Its state word is still empty by design, which is why the line is where this goes.
    expect(stateSlotWord({ ...local("no-daemon"), indicator: { label: "Unreachable", tone: "neutral", pulse: false } })).toBe("");
    // What the runtime is doing to the daemon still leads: a note means an attempt is in flight.
    expect(workspaceMetaLine({ project: project({ reach: { state: "no-daemon" }, daemonNote: "updating the helper" }, { kind: "local" }), cost: null, outOfMemory: undefined, nowMs: now })).toBe("updating the helper");
    // The Spaces header says it above what the machine is, in the same place the row gives it.
    expect(spaceHeaderLines({ project: local("no-daemon"), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toEqual(["no daemon answering", "this computer"]);
    expect(daemonGoneLine("slow", kindWords("local"))).toBeUndefined();
    expect(daemonGoneLine(null, kindWords("local"))).toBeUndefined();
  });

  it("a fork whose daemon died says so too: Unreachable alone reads as a lost machine, and this one is fine", () => {
    const driven = (reach: ReachState) => project({ reach: { state: reach } });
    const line = (reach: ReachState) => workspaceMetaLine({ project: driven(reach), cost: tick(0.29), outOfMemory: undefined, nowMs: now });
    expect(line("no-daemon")).toBe("no daemon answering");
    // Nothing else changed: a reach that says nothing about the daemon leaves the spend and the countdown alone.
    expect(line("reachable")).toBe("$0.29 today · $0.110/hr · active");
    expect(line("slow")).toBe("$0.29 today · $0.110/hr · edge slow · active");
    // While the runtime is putting the daemon back, that is what the row says instead.
    expect(workspaceMetaLine({ project: project({ reach: { state: "no-daemon" }, daemonNote: "restarting the helper" }), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toBe("restarting the helper");
    // The Spaces header leads with it above the size, where the row's line sits.
    expect(spaceHeaderLines({ project: driven("no-daemon"), cost: tick(0.29), outOfMemory: undefined, nowMs: now })[0]).toBe("no daemon answering");
    // Only the daemon that died crosses to a driven kind. A machine wsp forks is built with the road to a daemon,
    // so a fork's row saying there is none would be saying something that cannot be true of it.
    expect(line("unsupported")).toBe("$0.29 today · $0.110/hr · active");
    expect(spaceHeaderLines({ project: driven("unsupported"), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).not.toContain("no daemon on this machine");
    expect(daemonGoneLine("unsupported", kindWords("cloud"))).toBeUndefined();
    expect(daemonGoneLine("unsupported", kindWords("local"))).toBe("no daemon on this machine");
    // A kind whose machines serve no daemon has none to miss, so neither line reaches its row.
    expect(daemonGoneLine("unsupported", kindWords("ssh"))).toBeUndefined();
    expect(daemonGoneLine("no-daemon", kindWords("ssh"))).toBeUndefined();
  });

  it("a machine over ssh serves no daemon at all, so its row says what the machine is rather than that one is missing", () => {
    const over = (reach: ReachState) => project({ reach: { state: reach } }, { kind: "ssh" });
    const line = (reach: ReachState) => workspaceMetaLine({ project: over(reach), cost: tick(0.29), outOfMemory: undefined, nowMs: now });
    // unsupported is this kind's steady state, not a daemon that went away, and the row has nowhere else to say
    // what the machine is.
    expect(line("unsupported")).toBe(OVER_SSH);
    expect(line("reachable")).toBe(OVER_SSH);
    // The Spaces header reads the same rule, and what the runtime is doing still leads on both surfaces.
    expect(spaceHeaderLines({ project: over("unsupported"), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toEqual([OVER_SSH]);
    expect(workspaceMetaLine({ project: project({ reach: { state: "unsupported" }, daemonNote: "updating the helper" }, { kind: "ssh" }), cost: null, outOfMemory: undefined, nowMs: now })).toBe("updating the helper");
    // This computer keeps the note: its host wires a daemon, so one missing is a fact worth the line.
    expect(workspaceMetaLine({ project: project({ reach: { state: "unsupported" } }, { kind: "local" }), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toBe("no daemon on this machine");
  });

  it("thread pills key on the session status, wear the adapter's word, and use tokens: only the running dot is the success colour", () => {
    expect(threadPill({ status: "running", indicator: { label: "Working", tone: "neutral", pulse: true } })).toMatchObject({ label: "Working", pulse: true, dotClass: expect.stringContaining("sidebar-whisper") });
    expect(threadPill({ status: "failed", indicator: { label: "Ended", tone: "neutral", pulse: false } })).toMatchObject({ label: "Ended", dotClass: expect.stringContaining("sidebar-whisper") });
    expect(threadPill({ status: "failed", indicator: { label: "Stopped short", tone: "neutral", pulse: false } })).toMatchObject({ label: "Stopped short" });
    expect(threadPill({ status: "completed", indicator: { label: "Idle", tone: "neutral", pulse: false } })).toBeNull();
    expect(threadPill({ status: "interrupted", indicator: { label: "Idle", tone: "neutral", pulse: false } })).toBeNull();
    expect(threadPill({ status: "running", indicator: null })).toBeNull();
    expect(dotClassForTone("running")).toContain("success");
    for (const cls of [dotClassForTone("paused"), dotClassForTone("neutral")]) expect(cls).toContain("muted-foreground");
    for (const cls of [dotClassForTone("running"), dotClassForTone("paused"), dotClassForTone("neutral")]) {
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

describe("what a space walks", () => {
  const row = (id: string, status: "running" | "completed", startedAt: string) => ({ id, title: id, status, startedAt, endedAt: startedAt });

  it("orders a workspace's threads the way the sidebar draws them: the working rows, then the idle shelf", () => {
    const threads = [
      row("idle-old", "completed", "2026-09-01T00:01:00Z"),
      row("working-old", "running", "2026-09-01T00:02:00Z"),
      row("idle-new", "completed", "2026-09-01T00:09:00Z"),
      row("working-new", "running", "2026-09-01T00:08:00Z"),
    ];
    expect(sidebarThreadOrder(threads).map(t => t.id)).toEqual(["working-new", "working-old", "idle-new", "idle-old"]);
    expect(topSidebarThread(threads)?.id).toBe("working-new");
    expect(sidebarThreadOrder([])).toEqual([]);
    expect(topSidebarThread([])).toBeNull();
  });

  it("shows the selected workspace, and the first in the sidebar's order while what is selected is not one", () => {
    const ids = ["ws_a", "ws_b"];
    expect(spaceWorkspaceId(ids, "ws_b")).toBe("ws_b");
    expect(spaceWorkspaceId(ids, null)).toBe("ws_a");
    expect(spaceWorkspaceId(ids, "creating:1")).toBe("ws_a");
    expect(spaceWorkspaceId([], "ws_a")).toBeNull();
  });
});
