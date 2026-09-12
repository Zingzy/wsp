// SPDX-License-Identifier: AGPL-3.0-only
// The Processes surface over a fake daemon wire: the tree with its labels,
// the sort and filter controls, the lit row's inspect fields, the two-step
// kill with a fake clock, the fixed row height, and on this computer the
// threads' own trees, the toggle the rest of the computer sits behind and the
// count of what is on the screen.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_ON_THIS_KIND, servesReading, type ProcEntry, type ProcSnapshot, type SessionView } from "@wsp/protocol";
import { ProcessesSurface, ROW_PX } from "../src/components/procs/ProcessesSurface.js";
import { provideDaemonHello, provideDaemonWire } from "../src/files/wire.js";
import { getProcs, resetProcs } from "../src/machine/procs.js";
import { useStore } from "../src/protocol/store.js";
import { DAEMON_ROOT, fakeWire, resetSurfaces, view, WS, type FakeWire } from "./surface-harness.js";

const DAEMON = 40;

const proc = (pid: number, ppid: number, comm: string, extra: Partial<ProcEntry> = {}): ProcEntry => ({
  pid,
  ppid,
  user: "root",
  state: "S",
  comm,
  cmdline: comm,
  cpu: 0,
  rss: 0,
  startedAt: 1_757_000_000_000,
  ...extra,
});

const PROCS: ProcEntry[] = [
  proc(1, 0, "init", { cmdline: "/sbin/init" }),
  proc(DAEMON, 1, "node", { cpu: 3.25, rss: 48 * 1024 ** 2, cmdline: "node /opt/wsp/daemon.js" }),
  proc(41, DAEMON, "bash", { cpu: 0.5, rss: 4 * 1024 ** 2, cmdline: "bash -l", pty: "pty_1" }),
  proc(42, DAEMON, "claude", { cpu: 30, rss: 900 * 1024 ** 2, cmdline: "claude -p hello", state: "R" }),
  proc(50, 1, "nginx", { cpu: 2, rss: 12 * 1024 ** 2, cmdline: "nginx: master process" }),
  proc(51, 1, "kworker/0:1", { cmdline: "" }),
];

const snapshot = (procs: ProcEntry[], at = 1_000): ProcSnapshot => ({ type: "proc.snapshot", at, daemon: DAEMON, total: procs.length, procs });

// This computer, with two threads of this workspace running under the host: each turn's shell, its agent and what
// the agent started.
const OWN: ProcEntry[] = [
  ...PROCS,
  proc(100, DAEMON, "bash", { cpu: 0.5, rss: 2 * 1024 ** 2, cmdline: "bash -c claude -p docs" }),
  proc(101, 100, "claude", { cpu: 40, rss: 800 * 1024 ** 2, cmdline: "claude --settings {} -p docs" }),
  proc(102, 101, "rg", { cpu: 5, rss: 30 * 1024 ** 2, cmdline: "rg needle" }),
  proc(200, DAEMON, "bash", { cpu: 0.5, rss: 2 * 1024 ** 2, cmdline: "bash -c claude -p tests" }),
  proc(201, 200, "claude", { cpu: 10, rss: 700 * 1024 ** 2, cmdline: "claude --settings {} -p tests" }),
];

const session = (id: string, title: string, pid?: number): SessionView => ({
  id,
  workspaceId: WS,
  harness: "claude",
  status: pid === undefined ? "completed" : "running",
  threadId: id,
  harnessTitle: title,
  ...(pid !== undefined ? { pid } : {}),
});

/** This computer's workspace with rows for its threads, as the host answers a listing while their turns run. */
const onThisMac = (sessions: SessionView[]) => act(() => useStore.setState({ workspaces: [{ ...view, kind: "local" }], sessions: { [WS]: sessions } }));

let wire: FakeWire;

beforeEach(() => {
  resetSurfaces();
  resetProcs();
  wire = fakeWire({
    "proc.watch": {},
    "proc.unwatch": {},
    "proc.inspect": p => ({ pid: p["pid"], cwd: "/root/app", ports: [8080, 3000], threads: 7, children: [41, 42] }),
    "proc.kill": {},
  });
  provideDaemonWire(WS, wire);
  getProcs(WS).feedStatus("live");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-proc-row]"));
const pids = () => rows().map(r => Number(r.dataset["procRow"]));
const row = (pid: number): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-proc-row="${pid}"]`);
  if (!el) throw new Error(`no row for pid ${pid}`);
  return el;
};
const calls = (op: string) => wire.calls.filter(([o]) => o === op).map(([, p]) => p);
const feed = (procs: ProcEntry[], at?: number) => act(() => getProcs(WS).feedSnapshot(snapshot(procs, at)));
const flush = () => act(async () => {});

describe("processes surface", () => {
  it("asks the daemon to watch on mount and to stop on unmount, and shows the tree with the harness labelled", async () => {
    const { unmount } = render(<ProcessesSurface workspaceId={WS} />);
    expect(calls("proc.watch")).toHaveLength(1);
    expect(screen.getByText("pending")).toBeTruthy();
    await feed(PROCS);
    expect(screen.getByText("6 processes")).toBeTruthy();
    // cpu order within each set of siblings; the tree keeps parents above children.
    expect(pids()).toEqual([1, DAEMON, 42, 41, 50, 51]);
    const indent = (pid: number) => row(pid).querySelector<HTMLElement>("[title]")!.style.paddingLeft;
    expect(indent(1)).toBe("8px");
    expect(indent(DAEMON)).toBe("20px");
    expect(indent(42)).toBe("32px");
    const label = (pid: number) => row(pid).querySelector("[data-proc-label]")?.textContent ?? null;
    expect(label(DAEMON)).toBe("daemon");
    expect(label(41)).toBe("terminal");
    expect(label(42)).toBe("agent");
    expect(label(50)).toBeNull();
    // A kernel thread has no cmdline: its comm stands in, bracketed.
    expect(row(51).textContent).toContain("[kworker/0:1]");
    expect(row(42).querySelector("[data-col='cpu']")!.textContent).toBe("30.0");
    expect(row(42).querySelector("[data-col='mem']")!.textContent).toBe("900M");
    expect(row(DAEMON).querySelector("[data-col='mem']")!.textContent).toBe("48M");
    // Nothing is lit until a row is chosen.
    expect(document.querySelectorAll("[data-selected]")).toHaveLength(0);
    unmount();
    expect(calls("proc.unwatch")).toHaveLength(1);
  });

  it("a daemon that refuses proc.watch: the count reads unavailable, never pending, and one line carries the reason", async () => {
    delete wire.replies["proc.watch"];
    render(<ProcessesSurface workspaceId={WS} />);
    await flush();
    expect(getProcs(WS).snapshot()).toEqual({ snapshot: null, reach: "live", unavailable: "unknown op: proc.watch" });
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("unavailable");
    expect(screen.queryByText("pending")).toBeNull();
    const line = document.querySelector<HTMLElement>("[data-procs-unavailable]")!;
    expect(line.textContent).toBe("unknown op: proc.watch");
    expect(line.getAttribute("title")).toBe("unknown op: proc.watch");
    expect(line.style.lineHeight).toBe(`${ROW_PX}px`);
    expect(line.className).not.toMatch(/warning|caution|destructive|success/);
    // A daemon too old for proc.watch itself: the line names what it predates, and the runtime is already replacing it.
    act(() => provideDaemonHello(WS, { root: DAEMON_ROOT, version: 1 }));
    expect(document.querySelector("[data-procs-unavailable]")!.textContent).toBe("daemon v1 predates Live, Processes and Files in imported projects");
    // A daemon that answers proc.watch and only predates the files pane did not cause this refusal, so the refusal
    // stands as itself; blaming the version would point at an update that fixes nothing the person hit.
    act(() => provideDaemonHello(WS, { root: DAEMON_ROOT, version: 2 }));
    expect(document.querySelector("[data-procs-unavailable]")!.textContent).toBe("unknown op: proc.watch");
    // A redeployed daemon answers the watch: the reason goes and the rows fill.
    wire.replies["proc.watch"] = {};
    act(() => {
      provideDaemonHello(WS, { root: DAEMON_ROOT, version: 2 });
      getProcs(WS).feedStatus("connecting");
      getProcs(WS).feedStatus("live");
    });
    await flush();
    expect(getProcs(WS).snapshot().unavailable).toBeNull();
    await feed(PROCS);
    expect(document.querySelector("[data-procs-unavailable]")).toBeNull();
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("6 processes");
  });

  it("a workspace with only the daemon running shows the daemon", async () => {
    render(<ProcessesSurface workspaceId={WS} />);
    await feed([proc(1, 0, "init"), proc(DAEMON, 1, "node", { cmdline: "node daemon.js" })]);
    expect(pids()).toEqual([1, DAEMON]);
    expect(row(DAEMON).textContent).toContain("daemon");
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("2 processes");
  });

  it("sorts by mem on its header and back by cpu", async () => {
    render(<ProcessesSurface workspaceId={WS} />);
    await feed(PROCS);
    const mem = screen.getByRole("button", { name: "mem" });
    const cpu = screen.getByRole("button", { name: "cpu" });
    expect(cpu.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(mem);
    expect(mem.getAttribute("aria-pressed")).toBe("true");
    expect(cpu.getAttribute("aria-pressed")).toBe("false");
    expect(pids()).toEqual([1, DAEMON, 42, 41, 50, 51]);
    await feed([...PROCS.filter(p => p.pid !== 50), proc(50, 1, "nginx", { cpu: 2, rss: 2 * 1024 ** 3 })]);
    expect(pids()).toEqual([1, 50, DAEMON, 42, 41, 51]);
    fireEvent.click(cpu);
    expect(pids()).toEqual([1, DAEMON, 42, 41, 50, 51]);
  });

  it("the filter keeps each match under its own parents, and the count reads the rows shown", async () => {
    render(<ProcessesSurface workspaceId={WS} />);
    await feed(PROCS);
    fireEvent.change(screen.getByLabelText("Filter processes"), { target: { value: "ngin" } });
    expect(pids()).toEqual([1, 50]);
    expect(row(50).querySelector<HTMLElement>("[title]")!.style.paddingLeft).toBe("20px");
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("2 of 6");
    fireEvent.change(screen.getByLabelText("Filter processes"), { target: { value: "4" } });
    expect(pids()).toEqual([1, DAEMON, 42, 41]);
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("4 of 6");
    fireEvent.change(screen.getByLabelText("Filter processes"), { target: { value: "" } });
    expect(pids()).toEqual([1, DAEMON, 42, 41, 50, 51]);
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("6 processes");
  });

  it("selecting a row lights only it and opens the daemon's inspect fields under it", async () => {
    render(<ProcessesSurface workspaceId={WS} />);
    await feed(PROCS);
    fireEvent.click(row(DAEMON));
    await flush();
    expect(calls("proc.inspect")).toEqual([{ pid: DAEMON }]);
    expect(Array.from(document.querySelectorAll<HTMLElement>("[data-selected]")).map(r => r.dataset["procRow"])).toEqual([String(DAEMON)]);
    const details = document.querySelector<HTMLElement>(`[data-proc-details="${DAEMON}"]`)!;
    const field = (k: string) => details.querySelector(`[data-k="${k}"]`)!.textContent;
    expect(field("user")).toBe("root");
    expect(field("cwd")).toBe("/root/app");
    expect(field("ports")).toBe("8080 3000");
    expect(field("threads")).toBe("7");
    expect(field("children")).toBe("41 42");
    expect(field("command")).toBe("node /opt/wsp/daemon.js");
    expect(details.querySelector("[data-k='env']")).toBeNull();
    // The details sit under the daemon's row and before the next one.
    expect(details.compareDocumentPosition(row(42)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Another row takes the light; the first is unlit and its details are gone.
    fireEvent.click(row(50));
    await flush();
    expect(Array.from(document.querySelectorAll<HTMLElement>("[data-selected]")).map(r => r.dataset["procRow"])).toEqual(["50"]);
    expect(document.querySelector(`[data-proc-details="${DAEMON}"]`)).toBeNull();
    expect(calls("proc.inspect")).toEqual([{ pid: DAEMON }, { pid: 50 }]);
    // Clicking the lit row again puts the light out.
    fireEvent.click(row(50));
    expect(document.querySelectorAll("[data-selected]")).toHaveLength(0);
  });

  it("a lit process that went away loses its light", async () => {
    render(<ProcessesSurface workspaceId={WS} />);
    await feed(PROCS);
    fireEvent.click(row(50));
    await flush();
    await feed(PROCS.filter(p => p.pid !== 50), 3_000);
    expect(document.querySelectorAll("[data-selected]")).toHaveLength(0);
    expect(document.querySelector("[data-proc-details]")).toBeNull();
  });

  it("kill is two presses within two seconds for TERM, and offers KILL only once TERM did nothing for five seconds", async () => {
    vi.useFakeTimers();
    render(<ProcessesSurface workspaceId={WS} />);
    await feed(PROCS);
    fireEvent.click(row(50));
    await flush();
    const button = () => document.querySelector<HTMLButtonElement>("[data-proc-kill] button");
    expect(button()!.textContent).toBe("kill");
    expect(button()!.dataset["signal"]).toBe("TERM");

    // Armed, then left alone: the arm lapses without a request.
    fireEvent.click(button()!);
    expect(button()!.textContent).toBe("confirm TERM");
    act(() => vi.advanceTimersByTime(1_900));
    expect(button()!.textContent).toBe("confirm TERM");
    act(() => vi.advanceTimersByTime(300));
    expect(button()!.textContent).toBe("kill");
    expect(calls("proc.kill")).toEqual([]);

    // Armed and confirmed in time: TERM goes out and the button gives way to the word.
    fireEvent.click(button()!);
    act(() => vi.advanceTimersByTime(500));
    fireEvent.click(button()!);
    await flush();
    expect(calls("proc.kill")).toEqual([{ pid: 50, signal: "TERM" }]);
    expect(button()).toBeNull();
    expect(document.querySelector("[data-proc-sent]")!.textContent).toBe("TERM sent");
    act(() => vi.advanceTimersByTime(4_500));
    expect(button()).toBeNull();
    act(() => vi.advanceTimersByTime(750));
    expect(button()!.textContent).toBe("kill -9");
    expect(button()!.dataset["signal"]).toBe("KILL");

    // KILL takes the same two presses.
    fireEvent.click(button()!);
    expect(button()!.textContent).toBe("confirm KILL");
    fireEvent.click(button()!);
    await flush();
    expect(calls("proc.kill")).toEqual([{ pid: 50, signal: "TERM" }, { pid: 50, signal: "KILL" }]);
    expect(document.querySelector("[data-proc-sent]")!.textContent).toBe("KILL sent");
  });

  it("a refused kill shows the daemon's reason on the row", async () => {
    wire.replies["proc.kill"] = () => new Error("refusing to signal pid 1: it is init, the daemon or the daemon's parent");
    render(<ProcessesSurface workspaceId={WS} />);
    await feed(PROCS);
    fireEvent.click(row(1));
    await flush();
    const button = () => document.querySelector<HTMLButtonElement>("[data-proc-kill] button")!;
    fireEvent.click(button());
    fireEvent.click(button());
    await flush();
    expect(document.querySelector("[data-proc-kill]")!.textContent).toContain("refusing to signal pid 1");
  });

  it("every row is the same fixed height, lit or not", async () => {
    render(<ProcessesSurface workspaceId={WS} />);
    await feed(PROCS);
    fireEvent.click(row(42));
    await flush();
    expect(rows()).toHaveLength(6);
    for (const r of rows()) expect(r.style.height).toBe(`${ROW_PX}px`);
  });

  it("a dropped link keeps the last table dim under the word for it and takes the kill button away", async () => {
    render(<ProcessesSurface workspaceId={WS} />);
    await feed(PROCS);
    fireEvent.click(row(50));
    await flush();
    act(() => getProcs(WS).feedStatus("connecting"));
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("unreachable");
    expect(document.querySelector("[role='table']")!.getAttribute("data-stale")).toBe("unreachable");
    expect(pids()).toHaveLength(6);
    expect(document.querySelector<HTMLButtonElement>("[data-proc-kill] button")!.disabled).toBe(true);
    // A paused workspace says so instead, in the word the Workspace panel and the sidebar row use for it.
    act(() => useStore.setState({ workspaces: [{ ...view, phase: "napping" }] }));
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("paused");
  });

  it("says the computer is not answering in the pane itself, in two halves, when that computer is the one holding the workspace", async () => {
    act(() =>
      useStore.setState({
        workspaces: [{ ...view, kind: "place", machineId: "place:p_oldlaptop" }],
        places: [{ id: "p_oldlaptop", kind: "computer", name: "old-laptop", default: true, present: false, lastSeenAt: new Date(Date.now() - 38 * 60_000).toISOString(), workspaceId: WS }],
      }),
    );
    render(<ProcessesSurface workspaceId={WS} />);
    await flush();
    const said = document.querySelector("[data-procs-unavailable]")!;
    expect(said.textContent).toBe("old-laptop is not answeringit connects on its own when it is on");
    expect(said.textContent).not.toContain("daemon");
    expect(said.textContent).not.toContain("place:");
  });

  it("a machine over ssh lists its own, since the daemon on it reads that machine's own /proc", async () => {
    act(() => useStore.setState({ workspaces: [{ ...view, kind: "ssh" }] }));
    render(<ProcessesSurface workspaceId={WS} />);
    await flush();
    // Pending until the first snapshot lands, the way a fork's does, rather than the kind's word: this kind
    // answers the watch now.
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("pending");
    expect(document.querySelector("[data-procs-count]")!.textContent).not.toBe(NOT_ON_THIS_KIND);
    // The slot a kind that lists none would fill is the table's to decide, and every kind lists its own today.
    for (const kind of ["local", "cloud", "ssh"] as const) expect(servesReading(kind, "processes")).toBe(true);
  });

  it("this computer lists its own: pending only until the first snapshot lands", async () => {
    onThisMac([]);
    render(<ProcessesSurface workspaceId={WS} />);
    await flush();
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("pending");
    // Nothing is split before the first snapshot: what this computer runs is not known yet.
    expect(document.querySelector("[data-procs-rest]")).toBeNull();
    expect(document.querySelector("[data-procs-no-threads]")).toBeNull();
    await feed(PROCS);
    // Nothing of this workspace is running, so the table is empty until the computer is opened, and the count says so.
    expect(document.querySelector("[data-procs-no-threads]")!.textContent).toBe("no thread of this workspace is running here");
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("0 of 6");
    // Nothing of this workspace is running, so the toggle offers the Mac whole rather than the rest of it.
    expect(document.querySelector("[data-procs-rest]")!.textContent).toBe("everything on this Mac6");
    // A filter changes what is on the list, not whether a thread of this workspace is running here.
    fireEvent.change(screen.getByLabelText("Filter processes"), { target: { value: "ngin" } });
    expect(document.querySelector("[data-procs-no-threads]")!.textContent).toBe("no thread of this workspace is running here");
    expect(document.querySelector("[data-procs-rest]")!.textContent).toBe("everything on this Mac2");
    fireEvent.change(screen.getByLabelText("Filter processes"), { target: { value: "" } });
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-procs-rest]")!);
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("6 processes");
    expect(pids()).toContain(42);
  });

  it("on this computer the threads come first under their names, and the rest of it waits behind one toggle", async () => {
    onThisMac([session("th_docs", "the docs agent", 100), session("th_tests", "the tests agent", 200)]);
    render(<ProcessesSurface workspaceId={WS} />);
    await feed(OWN);
    const headings = Array.from(document.querySelectorAll<HTMLElement>("[data-procs-thread]"));
    expect(headings.map(h => [h.dataset["procsThread"], h.textContent])).toEqual([
      ["th_docs", "the docs agent"],
      ["th_tests", "the tests agent"],
    ]);
    // Each thread's own tree, nested under its name; nothing else on the computer is on the screen yet.
    expect(pids()).toEqual([100, 101, 102, 200, 201]);
    const indent = (pid: number) => row(pid).querySelector<HTMLElement>("[title]")!.style.paddingLeft;
    expect(indent(100)).toBe("20px");
    expect(indent(101)).toBe("32px");
    expect(indent(102)).toBe("44px");
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("5 of 11");
    const toggle = document.querySelector<HTMLButtonElement>("[data-procs-rest]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("the rest of this Mac6");

    // Opened, the rest of the computer follows, without the threads' own processes in it a second time.
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(pids()).toEqual([100, 101, 102, 200, 201, 1, DAEMON, 42, 41, 50, 51]);
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("11 processes");

    // A filter reads both, and the count is what it left.
    fireEvent.change(screen.getByLabelText("Filter processes"), { target: { value: "docs" } });
    expect(pids()).toEqual([100, 101]);
    // The thread with nothing left takes its heading with it, rather than standing over an empty space.
    expect(Array.from(document.querySelectorAll<HTMLElement>("[data-procs-thread]")).map(h => h.textContent)).toEqual(["the docs agent"]);
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("2 of 11");
    // Threads are running here and the filter left none of them: the section says that, and not that none runs, and
    // the toggle goes on offering the rest of the Mac rather than flipping its word while the person types.
    fireEvent.change(screen.getByLabelText("Filter processes"), { target: { value: "no such process" } });
    expect(document.querySelector("[data-procs-no-threads]")!.textContent).toBe("no thread of this workspace matches");
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("0 of 11");
    expect(toggle.textContent).toBe("the rest of this Mac0");

    // A thread whose turn ended carries no process, so its tree goes with it.
    onThisMac([session("th_docs", "the docs agent"), session("th_tests", "the tests agent", 200)]);
    fireEvent.change(screen.getByLabelText("Filter processes"), { target: { value: "" } });
    expect(Array.from(document.querySelectorAll<HTMLElement>("[data-procs-thread]")).map(h => h.textContent)).toEqual(["the tests agent"]);
    expect(pids()).toEqual([200, 201, 1, DAEMON, 42, 41, 100, 101, 102, 50, 51]);
  });

  it("a machine wsp forks is listed whole, with no threads section and no toggle", async () => {
    act(() => useStore.setState({ sessions: { [WS]: [session("th_docs", "the docs agent", 100)] } }));
    render(<ProcessesSurface workspaceId={WS} />);
    await feed(OWN);
    expect(document.querySelector("[data-procs-thread]")).toBeNull();
    expect(document.querySelector("[data-procs-rest]")).toBeNull();
    expect(pids()).toEqual([1, DAEMON, 42, 41, 100, 101, 102, 200, 201, 50, 51]);
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("11 processes");
  });

  it("a link that comes back is asked to watch again while the pane is open", async () => {
    render(<ProcessesSurface workspaceId={WS} />);
    expect(calls("proc.watch")).toHaveLength(1);
    act(() => getProcs(WS).feedStatus("connecting"));
    act(() => getProcs(WS).feedStatus("live"));
    expect(calls("proc.watch")).toHaveLength(2);
  });
});
