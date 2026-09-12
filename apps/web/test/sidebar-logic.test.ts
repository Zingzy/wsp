// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's pure logic: the copied t3code sort, search, traversal and
// pill rollup over wsp thread snapshots, plus our row labels and the
// new-workspace helpers.
import { describe, expect, it } from "vitest";
import { FREE_WORD, NO_BUILD_TOOLS_LINE, NO_LINGER_LINE, OVER_SSH, THIS_COMPUTER, THREAD_ARCHIVE_MS, kindWords, machineLacksShort, wakeAskingAgainLine, workspaceState, type ReachState, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../src/adapt/index.js";
import { RequestError } from "../src/protocol/client.js";
import { threadTree, threadsOpenedBy, workspaceOf } from "../src/sidebar/threadTree.js";
import { explainCreateRefusal } from "../src/protocol/store.js";
import {
  foldArchivedThreads,
  isThreadArchived,
  isThreadWorking,
  resolveAdjacentThreadId,
  searchSidebarThreadsByTitle,
  nestSpawnedThreads,
  sidebarThreadOrder,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
  splitSidebarThreads,
  topSidebarThread,
} from "../src/sidebar/Sidebar.logic.js";
import { spaceWorkspaceId } from "../src/sidebar/sidebarMode.js";
import { ROW_LINE_MAX, rowLineCut } from "../src/sidebar/rowGrammar.js";
import {
  compactTimeLabel,
  defaultWorkspaceName,
  machineLine,
  spaceHeaderLines,
  idleCountdownLabel,
  dotClassForTone,
  glyphStateClass,
  leadDimClass,
  stateSlotWord,
  threadPill,
  reachNote,
  daemonGoneLine,
  wakeAskNote,
  whereWord,
  threadMetaWords,
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

  it("the meta line: what it cost today first, in cents, then the edge note and the nap countdown last, the hourly rate left to the pane; the cost leads before the first tick too, as an honest zero", () => {
    const meta = (over: Partial<WorkspaceStatus>, cost: ReturnType<typeof tick> | null) => workspaceMetaLine({ project: project(over), cost, outOfMemory: undefined, nowMs: now });
    expect(meta({ idleAt: now + 14.5 * 60_000, reach: { state: "slow" } }, tick(0.0037))).toBe("$0.00 today · edge slow · naps in 14m");
    expect(meta({ idleAt: now + 14.5 * 60_000 }, tick(0.29))).toBe("$0.29 today · naps in 14m");
    expect(meta({ reach: { state: "unreachable" } }, tick(1.235))).toBe("$1.24 today · active");
    expect(meta({ phase: "napping", machineState: "paused", reach: { state: "napping" }, idleAt: now + 60_000 }, tick(0.18, 0))).toBe("$0.18 today");
    expect(meta({ machineState: "gone", reach: { state: "gone" }, idleAt: now + 60_000 }, tick(0.18))).toBe("$0.18 today");
    expect(meta({}, null)).toBe("$0.00 today · active");
    expect(meta({ phase: "napping", machineState: "paused", reach: { state: "napping" } }, null)).toBe("$0.00 today");
    // The rate is the pane's row, not this line's: the spend and the countdown are what fit the row's 30 characters.
    expect(meta({}, tick(0.5, 0.15))).toBe("$0.50 today · active");
  });

  it("a wake the provider has not taken puts the ask it is on beside the spend, in the two words the slot holds", () => {
    const meta = (over: Partial<WorkspaceStatus>) => workspaceMetaLine({ project: project(over), cost: tick(0.29), outOfMemory: undefined, nowMs: now });
    const waking = { phase: "waking" as const, machineState: "paused" as const, reach: { state: "napping" as const } };
    expect(meta({ ...waking, wakeAsk: { ask: 3, of: 30 } })).toBe("$0.29 today · asking 3/30");
    // The short reading is the long one's own words cut to the slot; the Machine tab shows the long one.
    expect(wakeAskNote(status({ ...waking, wakeAsk: { ask: 3, of: 30 } }))).toBe("asking 3/30");
    expect(wakeAskingAgainLine(3, 30)).toBe("waking, asking again (3 of 30)");
    // No ask in flight is no word: a paused row that gave up says its sentence on the tab and offers the rebuild.
    expect(meta({ phase: "napping", machineState: "paused", reach: { state: "napping" } })).toBe("$0.29 today");
    expect(wakeAskNote(null)).toBeNull();
  });

  it("what the runtime is doing to the machine's helper, or a drop with memory near full, takes the whole line", () => {
    const GiB = 1024 ** 3;
    expect(workspaceMetaLine({ project: project({ idleAt: now + 60_000, daemonNote: "updating the helper" }), cost: tick(0.5), outOfMemory: undefined, nowMs: now })).toBe("updating the helper");
    expect(workspaceMetaLine({ project: project({ idleAt: now + 60_000 }), cost: tick(0.5), outOfMemory: { used: 3.59 * GiB, total: 3.94 * GiB, load1: 6.4 }, nowMs: now })).toBe("out of memory, 3.6 of 3.9 GB");
    // Before a status arrives the record's own note is the line; a status without one says nothing about the helper.
    expect(workspaceMetaLine({ project: { ...project({}), status: null }, cost: null, outOfMemory: undefined, nowMs: now })).toBe("$0.00 today");
    expect(workspaceMetaLine({ project: { ...project({}, { daemonNote: "updating the helper" }), status: null }, cost: null, outOfMemory: undefined, nowMs: now })).toBe("updating the helper");
    expect(workspaceMetaLine({ project: project({}, { daemonNote: "updating the helper" }), cost: null, outOfMemory: undefined, nowMs: now })).toBe("$0.00 today · active");
  });

  it("a nap that could not store a vault says the machine's files are not backed up, on the row and in the Spaces header", () => {
    const refused = { vaultedAt: "2026-09-08T07:10:04.444Z", vaultRefused: "the export was 646 MB, over the 200 MB cap" };
    const napped = { phase: "napping" as const, machineState: "paused" as const, reach: { state: "napping" as const } };
    const line = (over: Partial<WorkspaceStatus>) => workspaceMetaLine({ project: project(over), cost: tick(0.18, 0), outOfMemory: undefined, nowMs: now });
    expect(line({ ...napped, ...refused })).toBe("no backup since 2026-09-08");
    // A vault the last nap stored leaves the row's figures alone.
    expect(line({ ...napped, vaultedAt: refused.vaultedAt })).toBe("$0.18 today");
    // Before a status arrives the record's own fact is the line, as the daemon note is.
    expect(workspaceMetaLine({ project: { ...project(napped, refused), status: null }, cost: null, outOfMemory: undefined, nowMs: now })).toBe("no backup since 2026-09-08");
    // What the runtime is doing to the daemon leads: that is what a person is waiting on, this holds until the next nap.
    expect(line({ ...napped, ...refused, daemonNote: "updating the helper" })).toBe("updating the helper");
    // The header says it under what the machine is, since the header draws every sentence.
    expect(spaceHeaderLines({ project: project({ ...napped, ...refused }), cost: tick(0.18, 0), outOfMemory: undefined, nowMs: now })).toEqual([
      "no backup since 2026-09-08",
      "2 vCPU · 4 GB",
      "$0.18 today",
    ]);
  });

  it("the state slot says nothing while running, since the dot says it, and the state's word otherwise", () => {
    const slot = (state: WorkspaceState, label: string, tone: "running" | "paused" | "neutral", pulse = false) =>
      stateSlotWord({ state, indicator: { label, tone, pulse }, workspace: project({}).workspace });
    expect(slot("running", "Running", "running")).toBe("");
    expect(slot("paused", "Paused", "paused")).toBe("Paused");
    expect(slot("gone", "Gone", "neutral")).toBe("Gone");
    expect(slot("waking", "Waking", "neutral", true)).toBe("Waking");
  });

  it("one machine line for the row and the Spaces header: the kind's words where it has them, else the size in the kind's word for a cpu, nothing before a status", () => {
    // This computer's line is its facts in a fork's grammar: cores, since they are not virtual, and whole GB.
    expect(machineLine(project({ size: { cpu: 10, memMb: 16384 } }, { kind: "local" }))).toBe("10 cores · 16 GB");
    expect(machineLine(project({}))).toBe("2 vCPU · 4 GB");
    expect(machineLine({ status: null, workspace: project({}).workspace })).toBeNull();
    expect(machineLine({ status: null, workspace: { ...project({}).workspace, kind: "local" } })).toBeNull();
    // A kind with its own words says them before any status has arrived, since no size is behind them.
    expect(machineLine({ status: null, workspace: { ...project({}).workspace, kind: "ssh" } })).toBe(OVER_SSH);
  });

  it("one rule maps a workspace's state to the row's kind glyph class: the success green while the machine runs, the bar's paused dim while it is paused, nothing for every other state", () => {
    const states: WorkspaceState[] = ["running", "pausing", "paused", "waking", "unreachable", "gone"];
    expect(states.map(state => glyphStateClass({ state }))).toEqual(["text-success-foreground", undefined, "opacity-50", undefined, undefined, undefined]);
    expect(states.map(state => leadDimClass({ state }))).toEqual([undefined, undefined, "opacity-50", undefined, undefined, undefined]);
  });

  it("the Spaces header of a machine wsp does not drive is its machine words and the word free: no figure, no rate, no nap line", () => {
    const header = (over: Partial<WorkspaceStatus>, view: Partial<WorkspaceView> = {}, meter: ReturnType<typeof tick> | null = null) =>
      spaceHeaderLines({ project: project(over, view), cost: meter, outOfMemory: undefined, nowMs: now });
    expect(header({ idleAt: now + 14.5 * 60_000, size: { cpu: 10, memMb: 16384 } }, { kind: "local" }, tick(0.29))).toEqual(["10 cores · 16 GB", FREE_WORD]);
    // Nothing the machine bills for reaches it, whatever the meter has ticked or the runtime has scheduled.
    expect(header({ size: { cpu: 10, memMb: 16384 } }, { kind: "local" })).toEqual(["10 cores · 16 GB", FREE_WORD]);
    // A fork's header is untouched: the size, the spend with its rate, the countdown when one is set.
    expect(header({ idleAt: now + 14.5 * 60_000 }, {}, tick(0.29))).toEqual(["2 vCPU · 4 GB", "$0.29 today · $0.110/hr", "naps in 14m"]);
    expect(header({})).toEqual(["2 vCPU · 4 GB", "$0.00 today · $0.110/hr"]);
    // What the runtime is doing to the daemon still leads on both kinds: it is the one thing there a person waits on.
    expect(header({ daemonNote: "updating the helper" }, { kind: "local" })).toEqual(["updating the helper", "2 cores · 4 GB", FREE_WORD]);
  });

  it("this computer's cost line reads free and nothing about naps or state: it runs while the host does", () => {
    const local = project({}, { kind: "local" });
    expect(workspaceMetaLine({ project: local, cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toBe(FREE_WORD);
    expect(workspaceMetaLine({ project: project({ idleAt: now + 14.5 * 60_000 }, { kind: "local" }), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toBe(FREE_WORD);
    expect(stateSlotWord({ ...local, indicator: { label: "Unreachable", tone: "neutral", pulse: false } })).toBe("");
    // What the runtime is doing to its daemon still takes the line: it is the one thing there a person waits on.
    expect(workspaceMetaLine({ project: project({ daemonNote: "updating the helper" }, { kind: "local" }), cost: null, outOfMemory: undefined, nowMs: now })).toBe("updating the helper");
  });

  it("a row says its daemon is gone on the meta line, whatever kind of machine it is", () => {
    const local = (reach: ReachState) => project({ reach: { state: reach } }, { kind: "local" });
    const line = (reach: ReachState) => workspaceMetaLine({ project: local(reach), cost: tick(0.29), outOfMemory: undefined, nowMs: now });
    // The two are different facts: nothing answering on the port, and no daemon road at all.
    expect(line("no-daemon")).toBe("no daemon answering");
    expect(line("unsupported")).toBe("no daemon on it");
    expect(line("reachable")).toBe(FREE_WORD);
    // Its state word is still empty by design, which is why the line is where this goes.
    expect(stateSlotWord({ ...local("no-daemon"), indicator: { label: "Unreachable", tone: "neutral", pulse: false } })).toBe("");
    // What the runtime is doing to the daemon still leads: a note means an attempt is in flight.
    expect(workspaceMetaLine({ project: project({ reach: { state: "no-daemon" }, daemonNote: "updating the helper" }, { kind: "local" }), cost: null, outOfMemory: undefined, nowMs: now })).toBe("updating the helper");
    // The Spaces header says it above what the machine is, in the same place the row gives it.
    expect(spaceHeaderLines({ project: local("no-daemon"), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toEqual(["no daemon answering", "2 cores · 4 GB", FREE_WORD]);
    expect(daemonGoneLine("slow", kindWords("local"))).toBeUndefined();
    expect(daemonGoneLine(null, kindWords("local"))).toBeUndefined();
  });

  it("a fork whose daemon died says so too: Unreachable alone reads as a lost machine, and this one is fine", () => {
    const driven = (reach: ReachState) => project({ reach: { state: reach } });
    const line = (reach: ReachState) => workspaceMetaLine({ project: driven(reach), cost: tick(0.29), outOfMemory: undefined, nowMs: now });
    expect(line("no-daemon")).toBe("no daemon answering");
    // Nothing else changed: a reach that says nothing about the daemon leaves the spend and the countdown alone.
    expect(line("reachable")).toBe("$0.29 today · active");
    expect(line("slow")).toBe("$0.29 today · edge slow · active");
    // While the runtime is putting the daemon back, that is what the row says instead.
    expect(workspaceMetaLine({ project: project({ reach: { state: "no-daemon" }, daemonNote: "restarting the helper" }), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toBe("restarting the helper");
    // The Spaces header leads with it above the size, where the row's line sits.
    expect(spaceHeaderLines({ project: driven("no-daemon"), cost: tick(0.29), outOfMemory: undefined, nowMs: now })[0]).toBe("no daemon answering");
    // Only the daemon that died crosses to a driven kind. A machine wsp forks is built with the road to a daemon,
    // so a fork's row saying there is none would be saying something that cannot be true of it.
    expect(line("unsupported")).toBe("$0.29 today · active");
    expect(spaceHeaderLines({ project: driven("unsupported"), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).not.toContain("no daemon on it");
    expect(daemonGoneLine("unsupported", kindWords("cloud"))).toBeUndefined();
    expect(daemonGoneLine("unsupported", kindWords("local"))).toBe("no daemon on it");
    // A machine over ssh carries one under the person's own login, so a row saying there is none is a fact about
    // that machine, the way it is on this computer.
    expect(daemonGoneLine("unsupported", kindWords("ssh"))).toBe("no daemon on it");
  });

  it("a machine over ssh says what the machine is and that it is free, and says when its daemon is missing", () => {
    const over = (reach: ReachState) => project({ reach: { state: reach } }, { kind: "ssh" });
    const line = (reach: ReachState) => workspaceMetaLine({ project: over(reach), cost: tick(0.29), outOfMemory: undefined, nowMs: now });
    // wsp neither forks nor bills this machine, so no rate and no spend reach its row whatever its daemon says.
    expect(line("reachable")).toBe(FREE_WORD);
    expect(machineLine(over("unsupported"))).toBe(OVER_SSH);
    // A daemon is put on it under the person's own login, so one missing is a fact the row carries, as on this
    // computer; what the runtime is doing about it still leads on both surfaces.
    expect(line("unsupported")).toBe("no daemon on it");
    expect(spaceHeaderLines({ project: over("reachable"), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toEqual([OVER_SSH, FREE_WORD]);
    expect(workspaceMetaLine({ project: project({ reach: { state: "unsupported" }, daemonNote: "updating the helper" }, { kind: "ssh" }), cost: null, outOfMemory: undefined, nowMs: now })).toBe("updating the helper");
    // This computer reads the same rule: its host wires a daemon, so one missing is a fact worth the line.
    expect(workspaceMetaLine({ project: project({ reach: { state: "unsupported" } }, { kind: "local" }), cost: tick(0.29), outOfMemory: undefined, nowMs: now })).toBe("no daemon on it");
  });

  it("a machine that told the host what it lacks says that on its row, in the first clause of what it said", () => {
    const said = (why: string) =>
      workspaceMetaLine({ project: project({ reach: { state: "unsupported" }, daemonRefusedAt: { machineId: "ssh://dev@box:22", at: "2026-09-11T14:04:50.380Z", why } }, { kind: "ssh" }), cost: tick(0.29), outOfMemory: undefined, nowMs: now });
    // Why, rather than the bare fact that none is there: the row cuts from the right, so it takes the head of the
    // sentence, which is what the machine has not got. Both refusals are written to fit it.
    expect(said(NO_BUILD_TOOLS_LINE)).toBe("this machine has no C compiler");
    expect(said(NO_LINGER_LINE)).toBe("this login does not linger");
    // The whole sentence carries the command to type, which is at the end of it and no row would show; the
    // Machine tab is where it goes, and that is proved where that surface is rendered.
    expect(NO_LINGER_LINE).toContain("loginctl enable-linger");
    expect(machineLacksShort(NO_LINGER_LINE)).not.toContain("loginctl");
    // Nothing said, nothing new: the row keeps the fact it always had.
    expect(daemonGoneLine("unsupported", kindWords("ssh"))).toBe("no daemon on it");
  });

  it("thread pills key on the session status, wear the adapter's word, and use tokens: only the running dot is the success colour", () => {
    expect(threadPill({ status: "running", indicator: { label: "Working", tone: "neutral", pulse: true } })).toMatchObject({ label: "Working", pulse: true, dotClass: expect.stringContaining("sidebar-whisper") });
    expect(threadPill({ status: "failed", indicator: { label: "Ended", tone: "neutral", pulse: false } })).toMatchObject({ label: "Ended", dotClass: expect.stringContaining("sidebar-whisper") });
    expect(threadPill({ status: "failed", indicator: { label: "Stopped short", tone: "neutral", pulse: false } })).toMatchObject({ label: "Stopped short" });
    expect(threadPill({ status: "completed", indicator: { label: "Idle", tone: "neutral", pulse: false } })).toBeNull();
    expect(threadPill({ status: "interrupted", indicator: { label: "Idle", tone: "neutral", pulse: false } })).toBeNull();
    expect(threadPill({ status: "running", indicator: null })).toBeNull();
    // One emerald in the sidebar: the running dot wears the token the row's kind glyph wears while running.
    expect(dotClassForTone("running")).toBe("bg-success-foreground");
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
    expect(explained.title).toMatch(/no more workspaces/i);
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

  it("draws a thread an agent spawned under the thread that spawned it, in the order it holds otherwise", () => {
    const spawned = (id: string, startedAt: string, parentThreadId?: string) => ({ ...row(id, "running", startedAt), ...(parentThreadId !== undefined ? { parentThreadId } : {}) });
    const threads = [
      spawned("lead", "2026-09-01T00:01:00Z"),
      spawned("other", "2026-09-01T00:09:00Z"),
      spawned("builder-b", "2026-09-01T00:03:00Z", "lead"),
      spawned("builder-a", "2026-09-01T00:04:00Z", "lead"),
      spawned("deeper", "2026-09-01T00:05:00Z", "builder-a"),
    ];
    // The sort puts the newest first; the tree then pulls each thread's own under it, keeping that order inside.
    expect(sidebarThreadOrder(threads).map(t => t.id)).toEqual(["other", "lead", "builder-a", "deeper", "builder-b"]);
    // A parent that is not in this list leaves the row where the sort put it rather than dropping it.
    expect(nestSpawnedThreads([spawned("orphan", "2026-09-01T00:01:00Z", "gone")]).map(t => t.id)).toEqual(["orphan"]);
    // A row naming itself as its own parent is drawn once, not forever, and two rows naming each other are both
    // drawn: a thread the sidebar leaves out is a thread nobody can reach.
    expect(nestSpawnedThreads([spawned("loop", "2026-09-01T00:01:00Z", "loop")]).map(t => t.id)).toEqual(["loop"]);
    const pair = [spawned("a", "2026-09-01T00:01:00Z", "b"), spawned("b", "2026-09-01T00:02:00Z", "a")];
    expect(nestSpawnedThreads(pair).map(t => t.id).sort()).toEqual(["a", "b"]);
  });

  it("shows the selected workspace, and the first in the sidebar's order while what is selected is not one", () => {
    const ids = ["ws_a", "ws_b"];
    expect(spaceWorkspaceId(ids, "ws_b")).toBe("ws_b");
    expect(spaceWorkspaceId(ids, null)).toBe("ws_a");
    expect(spaceWorkspaceId(ids, "creating:1")).toBe("ws_a");
    expect(spaceWorkspaceId([], "ws_a")).toBeNull();
  });
});

describe("the tree a thread's own threads make", () => {
  const thread = (id: string, workspaceId: string, parentThreadId: string | null): SidebarThreadSnapshot => ({
    id,
    threadId: id,
    sessionId: `s_${id}`,
    workspaceId,
    title: id,
    status: "running",
    ran: true,
    startedAt: "2026-09-01T00:00:00Z",
    endedAt: null,
    indicator: { label: "Working", tone: "neutral", pulse: true },
    harness: "claude",
    startedBy: parentThreadId === null ? "person" : "agent",
    project: null,
    parentThreadId,
    costUsd: null,
  });
  const project = (id: string, threads: SidebarThreadSnapshot[]): SidebarProjectSnapshot =>
    ({ id, displayName: id, threads }) as unknown as SidebarProjectSnapshot;
  const drawn = (projects: SidebarProjectSnapshot[]) => threadTree(projects).map(group => [group.project.id, group.threads.map(t => t.id)]);

  it("puts a thread an agent opened on another workspace among its opener's rows, and takes it off the workspace it runs on", () => {
    const mac = project("mac", [thread("lead", "mac", null)]);
    const bench = project("bench", [thread("builder", "bench", "lead")]);
    expect(drawn([mac, bench])).toEqual([
      ["mac", ["lead", "builder"]],
      ["bench", []],
    ]);
  });

  it("follows the chain to the thread a person opened, however many workspaces it crosses", () => {
    const mac = project("mac", [thread("lead", "mac", null)]);
    const bench = project("bench", [thread("builder", "bench", "lead")]);
    const web = project("web", [thread("helper", "web", "builder")]);
    expect(drawn([mac, bench, web])).toEqual([
      ["mac", ["lead", "builder", "helper"]],
      ["bench", []],
      ["web", []],
    ]);
  });

  it("leaves a thread whose opener this window does not hold where it runs, and never loses one to a circle", () => {
    const mac = project("mac", [thread("orphan", "mac", "gone")]);
    const bench = project("bench", [thread("a", "bench", "b"), thread("b", "bench", "a")]);
    expect(drawn([mac, bench])).toEqual([
      ["mac", ["orphan"]],
      ["bench", ["a", "b"]],
    ]);
  });

  it("answers the threads one thread opened with the workspace each runs on, whichever workspace that is", () => {
    const mac = project("mac", [thread("lead", "mac", null), thread("near", "mac", "lead")]);
    const bench = project("bench", [thread("far", "bench", "lead"), thread("other", "bench", null)]);
    expect(threadsOpenedBy([mac, bench], "lead").map(({ thread: t, runs }) => [t.id, runs.id])).toEqual([
      ["near", "mac"],
      ["far", "bench"],
    ]);
    expect(threadsOpenedBy([mac, bench], "other")).toEqual([]);
    expect(workspaceOf([mac, bench], { workspaceId: "bench" })?.id).toBe("bench");
    expect(workspaceOf([mac, bench], { workspaceId: "nowhere" })).toBeUndefined();
  });
});

describe("a thread row's words", () => {
  const spawned = { parentThreadId: "th_lead", project: "spoo", startedBy: "agent" as const };
  const own = { parentThreadId: null, project: "spoo", startedBy: "person" as const };
  const runs = (over: Partial<WorkspaceStatus>, view: Partial<WorkspaceView> = {}) => ({ status: status(over), workspace: { ...status(over), ...view } });

  it("a spawned row holds its workspace where a top row holds the project, and drops it when it is the row it is drawn under", () => {
    expect(threadMetaWords(spawned, { workspace: "spoo-bench", where: "ascii" }, "spoo-fix")).toEqual(["spoo-bench", "ascii"]);
    expect(threadMetaWords(spawned, { workspace: "spoo-fix", where: "hetzner" }, "spoo-fix")).toEqual(["hetzner"]);
  });

  it("a row a person or the command line opened keeps the project and who opened it, and never names a workspace", () => {
    expect(threadMetaWords(own, { workspace: "spoo-fix", where: "hetzner" }, "spoo-fix")).toEqual(["spoo", "you"]);
    expect(threadMetaWords({ ...own, startedBy: "cli" }, { workspace: "spoo-bench", where: "ascii" }, "spoo-fix")).toEqual(["spoo", "cli"]);
    expect(threadMetaWords({ ...own, project: null }, { workspace: "spoo-fix", where: "hetzner" }, "spoo-fix")).toEqual(["you"]);
  });

  it("where a workspace runs: the provider the record carries, the kind's own word where it has one, and the name wsp holds for the machine where it has neither", () => {
    expect(whereWord(runs({}, { kind: "local" }))).toBe(THIS_COMPUTER);
    // A fork runs at the provider its own record names, never the opaque id that provider minted for the machine,
    // and never a word read off the kind: this host is wired to one provider of several and only the record says which.
    expect(whereWord(runs({ machineId: "sb_9f2c1d8a", provider: "solari" }))).toBe("solari");
    expect(whereWord(runs({ machineId: "bx_4c11e0", provider: "box" }))).toBe("box");
    expect(whereWord(runs({ machineId: "wsp-api", provider: "docker" }))).toBe("docker");
    // A record from before the provider rode the wire says what the machine is; the id the provider minted for it
    // names nothing to the person reading the row, and no row anywhere shows one.
    expect(whereWord(runs({ machineId: "sb_9f2c1d8a" }))).toBe("a provider");
    expect(whereWord(runs({ machineId: "dev@box" }, { kind: "ssh" }))).toBe("dev@box");
    expect(whereWord({ status: null, workspace: { ...status({}), kind: "ssh", machineId: "m_recorded" } })).toBe("m_recorded");
  });
});

describe("the row's third line is cut at the sidebar's own room", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");

  it("a line within the cap is whole, one over it is cut at a word boundary with the ellipsis inside the cap", () => {
    expect(ROW_LINE_MAX).toBe(30);
    expect(rowLineCut("no answer 2 h · threads go on")).toBe("no answer 2 h · threads go on");
    expect(rowLineCut("$0.09 today · naps in 12m")).toBe("$0.09 today · naps in 12m");
    const long = "no backup since 2026-09-08, over the cap";
    expect(rowLineCut(long).length).toBeLessThanOrEqual(ROW_LINE_MAX);
    expect(rowLineCut(long)).toBe("no backup since 2026-09-08…");
    expect(rowLineCut("x".repeat(40))).toBe(`${"x".repeat(29)}…`);
  });

  it("the cost line leaves the hourly rate to the pane, so a row that bills and naps stays inside the cap", () => {
    const project = { state: "running" as const, status: status({ idleAt: now + 12.5 * 60_000 }), reach: "reachable" as const, workspace: status({}) };
    const line = workspaceMetaLine({ project, cost: { rateUsdPerHour: 0.018, accruedUsd: 0.09 }, outOfMemory: undefined, nowMs: now });
    expect(line).toBe("$0.09 today · naps in 12m");
    expect(line.length).toBeLessThanOrEqual(ROW_LINE_MAX);
  });
});
