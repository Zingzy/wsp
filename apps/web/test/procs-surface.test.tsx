// SPDX-License-Identifier: AGPL-3.0-only
// The Processes surface over a fake daemon wire: the tree with its labels,
// the sort and filter controls, the lit row's inspect fields, the two-step
// kill with a fake clock, and the fixed row height.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_ON_THIS_KIND, servesReading, type ProcEntry, type ProcSnapshot } from "@wsp/protocol";
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

  it("the filter box flattens the table to the matches", async () => {
    render(<ProcessesSurface workspaceId={WS} />);
    await feed(PROCS);
    fireEvent.change(screen.getByLabelText("Filter processes"), { target: { value: "ngin" } });
    expect(pids()).toEqual([50]);
    expect(row(50).querySelector<HTMLElement>("[title]")!.style.paddingLeft).toBe("8px");
    fireEvent.change(screen.getByLabelText("Filter processes"), { target: { value: "4" } });
    expect(pids()).toEqual([42, DAEMON, 41]);
    fireEvent.change(screen.getByLabelText("Filter processes"), { target: { value: "" } });
    expect(pids()).toEqual([1, DAEMON, 42, 41, 50, 51]);
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
    // A napping workspace says so instead.
    act(() => useStore.setState({ workspaces: [{ ...view, phase: "napping" }] }));
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("napping");
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
    act(() => useStore.setState({ workspaces: [{ ...view, kind: "local" }] }));
    render(<ProcessesSurface workspaceId={WS} />);
    await flush();
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("pending");
    await feed(PROCS);
    expect(document.querySelector("[data-procs-count]")!.textContent).toBe("6 processes");
    expect(pids()).toContain(42);
  });

  it("a link that comes back is asked to watch again while the pane is open", async () => {
    render(<ProcessesSurface workspaceId={WS} />);
    expect(calls("proc.watch")).toHaveLength(1);
    act(() => getProcs(WS).feedStatus("connecting"));
    act(() => getProcs(WS).feedStatus("live"));
    expect(calls("proc.watch")).toHaveLength(2);
  });
});
