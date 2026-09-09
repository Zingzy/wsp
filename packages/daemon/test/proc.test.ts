// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcSnapshot } from "@wsp/protocol";
import { OpError } from "../src/workspace-paths.js";
import { killProcess, parseAuxvPageSize, parseBtime, parsePasswdUsers, parseProcPidStat, ProcFsSource, ProcSampler } from "../src/proc.js";
import { auxv, BTIME, fakePasswd, fakeProcTree, writeProc, type FakeProc } from "./fake-proc.js";
import { rejectedEvents } from "./wire-events.js";

/** Every snapshot any sampler in this file emitted, checked against the protocol at the end. */
const wire: ProcSnapshot[] = [];

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function sampler(procs: FakeProc[], opts: { ptys?: { id: string; pid: number }[]; cap?: number; pageSize?: number; clock?: { now: number } } = {}) {
  const root = fakeProcTree(procs, opts.pageSize);
  roots.push(root);
  const clock = opts.clock ?? { now: 1_000_000 };
  const s = new ProcSampler(new ProcFsSource({ procRoot: root, passwdPath: fakePasswd(), ...(opts.cap !== undefined ? { cap: opts.cap } : {}) }), {
    selfPid: 4242,
    ptys: () => opts.ptys ?? [],
    now: () => clock.now,
    intervalMs: 60_000,
  });
  const got: ProcSnapshot[] = [];
  s.on("proc.snapshot", (e: ProcSnapshot) => {
    got.push(e);
    wire.push(e);
  });
  return { s, got, root, clock };
}

describe("proc parsing", () => {
  it("reads /proc/[pid]/stat around a comm that holds spaces and parens", () => {
    const st = parseProcPidStat("42 (my (odd) proc) R 7 42 42 0 -1 4194560 10 0 0 0 150 50 0 0 20 0 3 0 12345 1000000 256 " + new Array(28).fill(0).join(" ") + "\n");
    expect(st).toEqual({ pid: 42, comm: "my (odd) proc", state: "R", ppid: 7, ticks: 200, threads: 3, starttime: 12345, rssPages: 256 });
  });

  it("rejects a stat line without the comm parens", () => {
    expect(() => parseProcPidStat("42 broken\n")).toThrow();
  });

  it("btime, the page size from auxv and users from passwd", () => {
    expect(parseBtime(`cpu 1 2 3\nbtime ${BTIME}\n`)).toBe(BTIME);
    expect(parseAuxvPageSize(auxv(16384))).toBe(16384);
    expect(parseAuxvPageSize(Buffer.alloc(16))).toBeUndefined();
    expect(parsePasswdUsers("root:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534::/:/bin/false\nbad line\n")).toEqual(new Map([[0, "root"], [65534, "nobody"]]));
  });
});

describe("ProcSampler", () => {
  it("a probe scans once for the first watcher and rides the running stream for the next, refusal and all", async () => {
    let scans = 0;
    let broken = false;
    const source = {
      scan: async () => {
        scans++;
        if (broken) throw new Error("this machine cannot be read");
        return { total: 0, procs: [] };
      },
      inspect: async () => ({ pid: 1, cwd: null, ports: [], children: [] }),
    };
    const s = new ProcSampler(source, { intervalMs: 60_000 });
    await s.probe();
    expect(scans).toBe(1);
    const off = s.subscribe(() => {});
    await new Promise(r => setTimeout(r, 0));
    expect(scans).toBe(2);
    // Already polling, so the next watcher inherits that tick rather than scanning beside it: both modules keep per
    // pid state that a scan moves, and two scans in one window read the next delta low.
    await s.probe();
    expect(scans).toBe(2);
    broken = true;
    await s.poll();
    await expect(s.probe()).rejects.toThrow("cannot be read");
    expect(scans).toBe(3);
    off();
    broken = false;
    await s.probe();
    expect(scans).toBe(4);
  });


  it("emits nothing on the first poll and a snapshot of every process with cpu over the interval on the next", async () => {
    const { s, got, root, clock } = sampler(
      [
        { pid: 1, comm: "init", cmdline: ["/sbin/init", "splash"], starttime: 100, rss: 300 },
        { pid: 4242, ppid: 1, comm: "node", cmdline: ["node", "/opt/wsp/daemon.js"], ticks: [100, 50], starttime: 500, rss: 12_000 },
        { pid: 77, ppid: 4242, comm: "bash", cmdline: ["bash", "-l"], state: "R", threads: 2 },
        { pid: 2, comm: "kthreadd", cmdline: [] },
      ],
      { ptys: [{ id: "pty_1", pid: 77 }] },
    );
    await s.poll();
    expect(got).toEqual([]);
    // Two seconds later the daemon used 100 more ticks: one core's worth at 100 ticks a second is 50 percent.
    writeProc(root, { pid: 4242, ppid: 1, comm: "node", cmdline: ["node", "/opt/wsp/daemon.js"], ticks: [180, 70], starttime: 500, rss: 12_500 });
    clock.now += 2_000;
    await s.poll();
    expect(got).toHaveLength(1);
    const snap = got[0]!;
    expect(snap).toMatchObject({ type: "proc.snapshot", at: 1_002_000, daemon: 4242, total: 4 });
    expect(snap.procs.map(p => p.pid)).toEqual([1, 2, 77, 4242]);
    expect(snap.procs.find(p => p.pid === 4242)).toEqual({
      pid: 4242,
      ppid: 1,
      user: "tester",
      state: "S",
      comm: "node",
      cmdline: "node /opt/wsp/daemon.js",
      cpu: 50,
      rss: 12_500 * 4096,
      startedAt: (BTIME + 5) * 1000,
    });
    expect(snap.procs.find(p => p.pid === 77)).toMatchObject({ ppid: 4242, state: "R", cmdline: "bash -l", cpu: 0, pty: "pty_1" });
    expect(snap.procs.find(p => p.pid === 2)).toMatchObject({ comm: "kthreadd", cmdline: "" });
    expect(snap.procs.find(p => p.pid === 1)).toMatchObject({ cmdline: "/sbin/init splash", startedAt: (BTIME + 1) * 1000, rss: 300 * 4096 });
  });

  it("caps cmdline at 200 bytes, reads it again only after an exec changed the comm, and takes the page size from auxv", async () => {
    const long = "x".repeat(500);
    const { s, got, root, clock } = sampler([{ pid: 9, comm: "sh", cmdline: ["sh", "-c", long] }], { pageSize: 16384 });
    await s.poll();
    clock.now += 2_000;
    await s.poll();
    expect(got[0]!.procs[0]!.cmdline).toHaveLength(200);
    expect(got[0]!.procs[0]!.cmdline.startsWith("sh -c xxx")).toBe(true);
    expect(got[0]!.procs[0]!.rss).toBe(10 * 16384);
    // The same pid, comm and start time: the cached cmdline stands even though the file changed underneath.
    writeFileSync(join(root, "9", "cmdline"), "ignored\0");
    clock.now += 2_000;
    await s.poll();
    expect(got[1]!.procs[0]!.cmdline.startsWith("sh -c")).toBe(true);
    // An exec changes the comm; the cmdline is read afresh.
    writeProc(root, { pid: 9, comm: "node", cmdline: ["node", "app.js"] });
    clock.now += 2_000;
    await s.poll();
    expect(got[2]!.procs[0]).toMatchObject({ comm: "node", cmdline: "node app.js" });
  });

  it("drops a process that went away, reads a new one with cpu 0, and never counts a pid that returned with a new start time against the old ticks", async () => {
    const { s, got, root, clock } = sampler([{ pid: 5, ticks: [100, 0], starttime: 10 }, { pid: 6, ticks: [0, 0] }]);
    await s.poll();
    rmSync(join(root, "6"), { recursive: true });
    writeProc(root, { pid: 7, ticks: [900, 900] });
    writeProc(root, { pid: 5, ticks: [10, 0], starttime: 900 });
    clock.now += 2_000;
    await s.poll();
    expect(got[0]!.procs.map(p => [p.pid, p.cpu])).toEqual([[5, 0], [7, 0]]);
  });

  it("stops at the cap and says how many there were", async () => {
    const procs: FakeProc[] = [];
    for (let pid = 1; pid <= 12; pid++) procs.push({ pid });
    const { s, got, clock } = sampler(procs, { cap: 5 });
    await s.poll();
    clock.now += 2_000;
    await s.poll();
    expect(got[0]!.total).toBe(12);
    expect(got[0]!.procs.map(p => p.pid)).toEqual([1, 2, 3, 4, 5]);
  });

  it("runs from the first subscriber to the last and reads nothing in between polls", async () => {
    const { s, root } = sampler([{ pid: 1 }]);
    const a: ProcSnapshot[] = [];
    expect(s.running).toBe(false);
    const unA = s.subscribe(e => a.push(e));
    expect(s.running).toBe(true);
    const unB = s.subscribe(() => {});
    unA();
    unA();
    expect(s.running).toBe(true);
    unB();
    expect(s.running).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("inspect reads cwd, listening ports by socket inode, threads and children for one pid", async () => {
    const { s, root, clock } = sampler([
      { pid: 1, comm: "init" },
      { pid: 30, ppid: 1, comm: "node", threads: 7, cwd: "/root/app", socketInodes: [111_111, 222_222] },
      { pid: 31, ppid: 30, comm: "sh" },
      { pid: 32, ppid: 30, comm: "sh" },
      { pid: 40, ppid: 1, comm: "nginx", socketInodes: [333_333] },
    ]);
    writeFileSync(
      join(root, "net", "tcp"),
      [
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
        `   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 111111 1 0000000000000000 100 0 0 10 0`,
        `   1: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 333333 1 0000000000000000 100 0 0 10 0`,
        `   2: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 222222 1 0000000000000000 100 0 0 10 0`,
        "",
      ].join("\n"),
    );
    await s.poll();
    clock.now += 2_000;
    await s.poll();
    expect(await s.inspect(30)).toEqual({ pid: 30, cwd: "/root/app", ports: [8080], threads: 7, children: [31, 32] });
    expect(await s.inspect(40)).toEqual({ pid: 40, cwd: null, ports: [3000], threads: 1, children: [] });
    await expect(s.inspect(999)).rejects.toMatchObject({ code: "not-found" });
  });

  it("inspect without a running watch scans once for the children", async () => {
    const { s } = sampler([{ pid: 1 }, { pid: 2, ppid: 1 }]);
    expect((await s.inspect(1)).children).toEqual([2]);
  });
});

describe("killProcess", () => {
  const protectedPids = { self: 5000, parent: 4000 };

  it("refuses init, the daemon and the daemon's parent with code forbidden", () => {
    for (const pid of [1, 5000, 4000]) {
      let err: unknown;
      try {
        killProcess(pid, "TERM", protectedPids);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(OpError);
      expect((err as OpError).code).toBe("forbidden");
    }
  });

  it("a pid that is gone answers not-found", () => {
    // 2^22 - 1 is above every Linux pid_max default and no macOS pid.
    let err: unknown;
    try {
      killProcess(4_194_303, "TERM", protectedPids);
    } catch (e) {
      err = e;
    }
    expect((err as OpError).code).toBe("not-found");
  });

  it("sends TERM, then KILL, to a child this test started", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    await new Promise(r => setTimeout(r, 50));
    killProcess(child.pid!, "TERM", protectedPids);
    expect(await exited).toEqual({ code: null, signal: "SIGTERM" });

    // One process that ignores TERM, so nothing is left behind when KILL takes it.
    const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const stubbornExit = new Promise<string | null>(resolve => stubborn.once("exit", (_code, signal) => resolve(signal)));
    await new Promise(r => setTimeout(r, 100));
    killProcess(stubborn.pid!, "TERM", protectedPids);
    await new Promise(r => setTimeout(r, 100));
    expect(stubborn.exitCode).toBeNull();
    killProcess(stubborn.pid!, "KILL", protectedPids);
    expect(await stubbornExit).toBe("SIGKILL");
  });
});

describe("wire", () => {
  it("every snapshot a sampler emitted in this file is one the protocol parses", () => {
    expect(wire.length).toBeGreaterThan(0);
    expect(rejectedEvents(wire)).toEqual([]);
  });
});
