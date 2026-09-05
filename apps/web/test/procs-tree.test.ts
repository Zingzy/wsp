// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { ProcEntry } from "@wsp/protocol";
import { compactBytes } from "../src/components/machine/format.js";
import { procLabel, procRows } from "../src/components/procs/tree.js";

const proc = (pid: number, ppid: number, comm: string, extra: Partial<ProcEntry> = {}): ProcEntry => ({
  pid,
  ppid,
  user: "root",
  state: "S",
  comm,
  cmdline: comm,
  cpu: 0,
  rss: 0,
  startedAt: 0,
  ...extra,
});

const procs: ProcEntry[] = [
  proc(1, 0, "init"),
  proc(40, 1, "node", { cpu: 3, rss: 300, cmdline: "node daemon.js" }),
  proc(41, 40, "bash", { cpu: 1, rss: 50, pty: "pty_1" }),
  proc(42, 40, "claude", { cpu: 30, rss: 900 }),
  proc(50, 1, "nginx", { cpu: 2, rss: 400 }),
  // An orphan whose parent was cut by the daemon's cap roots itself.
  proc(77, 9999, "cron", { cpu: 0, rss: 10 }),
];

describe("procRows", () => {
  it("nests by ppid with siblings sorted by cpu, ties by pid, orphans at the root", () => {
    const rows = procRows(procs, "cpu", "");
    expect(rows.map(r => [r.proc.pid, r.depth])).toEqual([
      [1, 0],
      [40, 1],
      [42, 2],
      [41, 2],
      [50, 1],
      [77, 0],
    ]);
  });

  it("sorting by mem reorders siblings, not the tree", () => {
    const rows = procRows(procs, "mem", "");
    expect(rows.map(r => r.proc.pid)).toEqual([77, 1, 50, 40, 42, 41]);
  });

  it("a filter flattens to the matches sorted by the key, matching pid, comm, cmdline and user", () => {
    expect(procRows(procs, "cpu", "n").map(r => [r.proc.pid, r.depth])).toEqual([
      [40, 0],
      [50, 0],
      [1, 0],
      [77, 0],
    ]);
    expect(procRows(procs, "cpu", "42").map(r => r.proc.pid)).toEqual([42]);
    expect(procRows(procs, "mem", "DAEMON.JS").map(r => r.proc.pid)).toEqual([40]);
    expect(procRows(procs, "cpu", "root").map(r => r.proc.pid)).toEqual([42, 40, 50, 41, 1, 77]);
    expect(procRows(procs, "cpu", "nothing here")).toEqual([]);
  });
});

describe("procLabel", () => {
  const titles = new Map([["pty_1", "zsh"]]);
  it("names the daemon, a pty shell by its tab and the harness by its comm", () => {
    expect(procLabel(procs[1]!, 40, titles)).toBe("daemon");
    expect(procLabel(procs[2]!, 40, titles)).toBe("terminal zsh");
    expect(procLabel(procs[2]!, 40, new Map())).toBe("terminal");
    expect(procLabel(procs[3]!, 40, titles)).toBe("agent");
    expect(procLabel(procs[4]!, 40, titles)).toBeNull();
  });
});

describe("compactBytes", () => {
  it("one unit, no more than three significant digits", () => {
    expect(compactBytes(0)).toBe("0");
    expect(compactBytes(900)).toBe("900");
    expect(compactBytes(12 * 1024)).toBe("12K");
    expect(compactBytes(1.5 * 1024 ** 2)).toBe("1.5M");
    expect(compactBytes(123.4 * 1024 ** 2)).toBe("123M");
    expect(compactBytes(2.25 * 1024 ** 3)).toBe("2.3G");
  });
});
