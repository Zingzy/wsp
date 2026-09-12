// SPDX-License-Identifier: AGPL-3.0-only
// This computer's own two modules, the ones the local kind reads: the parsers
// on rows from both platforms, and the modules themselves run against the
// computer the test is on, since they must answer on macOS and on Linux alike.
// Fixture provenance: the Linux rows were captured from df -kP, ps and vm_stat
// (that one from a Mac, the rest from a Linux box) in the column order these
// modules ask for, the macOS ps rows hand-written in the same documented
// order, which is what makes them the fixtures worth keeping.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, tmpdir, totalmem, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kindWords, PROC_CMDLINE_BYTES, servesReading, WorkspaceKind, type ProcEntry } from "@wsp/protocol";
import { LocalProcSource, parsePs, parsePsNames } from "../src/proc-local.js";
import { KIND_READINGS, readingsFor } from "../src/readings.js";
import { availableFromVmStat, cpuTimesOf, hostSysSource, memorySourceFor, parseDf } from "../src/sys-local.js";
import { OpError } from "../src/workspace-paths.js";

const LINUX_DF = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/root         20554452 13269800   6387484      68% /
`;
const MAC_DF = `Filesystem  1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1    971350180  22461104 105442184    18%    /
`;
/** A volume mounted under a name with a space in it, which is a Mac's normal state (Macintosh HD). */
const SPACED_DF = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk4s2   1000000  400000    600000      40% /Volumes/Big Disk
`;

const LINUX_PS = `      1       0 S root      7040 00:00:03 Mon Sep  7 08:07:19 2026 /sbin/init
      2       0 S root         0 00:00:00 Mon Sep  7 08:07:19 2026 [kthreadd]
    904      1 Ssl root    151204 00:02:17 Mon Sep  7 08:09:01 2026 claude -p do the thing
`;
const MAC_PS = `  4212      1 Ss   zingzy   41232 0:04.31 Tue Sep  8 11:02:44 2026 claude --print hello
  4213   4212 R+   zingzy  900000 12:31.07 Tue Sep  8 11:02:45 2026 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer
`;
/** The name pass, where everything after the pid is the name however many spaces it holds. */
const MAC_PS_NAMES = `  4212 claude
  4213 Google Chrome Helper
`;
/** A Mac's vm_stat, whose free count alone reads this machine as 1.5 GB free of 16 GB while nothing is wrong. */
const MAC_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               98304.
Pages active:                            393216.
Pages inactive:                          262144.
Pages speculative:                        32768.
Pages throttled:                              0.
Pages wired down:                        196608.
Pages purgeable:                          16384.
"Translation faults":                 123456789.
Pages stored in compressor:               65536.
Pages occupied by compressor:             32768.
`;

describe("this computer's metrics module", () => {
  it("reads df's counts off the capacity column, whatever the device or the mount point is called", () => {
    expect(parseDf(LINUX_DF)).toEqual({ used: 13_269_800 * 1024, total: 20_554_452 * 1024 });
    expect(parseDf(MAC_DF)).toEqual({ used: 22_461_104 * 1024, total: 971_350_180 * 1024 });
    expect(parseDf(SPACED_DF)).toEqual({ used: 400_000 * 1024, total: 1_000_000 * 1024 });
    expect(() => parseDf("df: /nope: No such file or directory\n")).toThrow("no filesystem line");
  });

  it("sums the cores' times into the two counters the shared cpu rule runs on", () => {
    const core = (user: number, idle: number) => ({ model: "m", speed: 0, times: { user, nice: 1, sys: 2, idle, irq: 0 } });
    expect(cpuTimesOf([core(10, 100), core(20, 200)])).toEqual({ idle: 300, total: 336 });
  });

  it("counts a Mac's reclaimable pages as free, so its memory row reads what is in use and not what is untouched", () => {
    const PAGE = 16_384;
    // Free plus speculative plus the inactive list; purgeable is already inside those and is not added twice.
    expect(availableFromVmStat(MAC_VM_STAT)).toBe((98_304 + 32_768 + 262_144) * PAGE);
    // The kernel's own free count alone would call this Mac 1.5 GB free; the reclaimable pages make it 6.4 GB, so
    // its memory row reads 60 percent used where the free count alone reads 90.
    expect(availableFromVmStat(MAC_VM_STAT)).toBeGreaterThan(98_304 * PAGE);
    expect(() => availableFromVmStat("Pages free: 1.\n")).toThrow("no page size");
    expect(() => availableFromVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n")).toThrow("no free pages");
  });

  it("asks each platform for memory the way it answers honestly: the os module where it reads what is available", async () => {
    // Linux is the road node already reads MemAvailable on, so nothing is spawned for it. Memory moves between the
    // two reads, so the two agree to within a window rather than exactly.
    const linux = await memorySourceFor("linux")();
    expect(linux.total).toBe(totalmem());
    expect(Math.abs(linux.used - (totalmem() - freemem()))).toBeLessThan(64 * 1024 * 1024);
    // A platform with no row falls back to that same reading rather than to nothing.
    expect(await memorySourceFor("aix")()).toMatchObject({ total: totalmem() });
  });

  it.skipIf(platform() === "darwin")("the darwin road is vm_stat, which only a Mac carries", async () => {
    // The dispatch is the claim here: darwin takes a road this box cannot walk, so it is not the os module's. The
    // arithmetic of that road is pinned on the fixture above, and a run of this file on his Mac walks it for real.
    await expect(memorySourceFor("darwin")()).rejects.toThrow();
  });

  it("reads this computer itself: the memory of its own platform, the disk of the folder it is given, a load", async () => {
    const reading = await hostSysSource(process.cwd())();
    expect(reading.mem.total).toBe(totalmem());
    expect(reading.mem.used).toBeGreaterThan(0);
    expect(reading.mem.used).toBeLessThan(reading.mem.total);
    expect(reading.disk.total).toBeGreaterThan(0);
    expect(reading.disk.used).toBeLessThanOrEqual(reading.disk.total);
    expect(reading.load1).toBeGreaterThanOrEqual(0);
    expect(reading.cpu.total).toBeGreaterThan(reading.cpu.idle);
    expect(reading.cpu.total).toBeGreaterThanOrEqual(cpuTimesOf(cpus()).total - 10_000);
  });
});

describe("this computer's processes module", () => {
  let burning: ReturnType<typeof spawn> | undefined;
  let burnDir: string | undefined;
  afterEach(() => {
    // Only a pid this test started, held from the spawn itself.
    burning?.kill("SIGKILL");
    burning = undefined;
    if (burnDir !== undefined) rmSync(burnDir, { recursive: true, force: true });
    burnDir = undefined;
  });

  /** Scans until a reading answers, since what a scan reports is what the test is waiting for: a fixed sleep buys
   * less on a loaded box than on an idle one, and the reading is the thing either way. Each scan is handed the wall
   * time since the last, which is the window the module divides its cpu by. */
  async function scanUntil(source: LocalProcSource, pid: number, what: string, ready: (row: ProcEntry | undefined) => boolean, ms = 30_000): Promise<ProcEntry> {
    const deadline = Date.now() + ms;
    let at = Date.now();
    let last: ProcEntry | undefined;
    for (;;) {
      const now = Date.now();
      const scan = await source.scan({ at: now, elapsedMs: now - at, pty: () => undefined });
      at = now;
      last = scan.procs.find(p => p.pid === pid);
      if (ready(last)) return last!;
      if (Date.now() >= deadline) throw new Error(`pid ${pid} never read as ${what} in ${ms} ms; last cpu ${last === undefined ? "no row" : last.cpu}`);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  it("reads ps rows into the columns the pane shows, on either platform's spelling", () => {
    const rows = parsePs(LINUX_PS);
    expect(rows.map(p => p.pid)).toEqual([1, 2, 904]);
    expect(rows[0]).toEqual({ pid: 1, ppid: 0, user: "root", state: "S", cmdline: "/sbin/init", cpuSeconds: 3, rss: 7040 * 1024, startedAt: Date.parse("Mon Sep 7 08:07:19 2026") });
    // A kernel thread has no argv; ps prints its name in brackets, and the pane draws that from the name itself.
    expect(rows[1]!.cmdline).toBe("");
    // The state carries flags on this road and one letter on the guest's, so both kinds show the letter.
    expect(rows[2]).toMatchObject({ pid: 904, state: "S", cmdline: "claude -p do the thing", cpuSeconds: 137, rss: 151_204 * 1024 });

    const mac = parsePs(MAC_PS);
    expect(mac.map(p => p.pid)).toEqual([4212, 4213]);
    expect(mac[0]).toMatchObject({ ppid: 1, user: "zingzy", state: "S", cmdline: "claude --print hello", cpuSeconds: 4.31 });
    // The argv is the only column allowed spaces here, so a Mac's own path with two of them arrives whole.
    expect(mac[1]!.cmdline).toBe("/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer");
    expect(mac[1]).toMatchObject({ ppid: 4212, state: "R", cpuSeconds: 751.07, rss: 900_000 * 1024 });
    expect(parsePs("ps: nothing to see\n")).toEqual([]);
  });

  it("takes the accounting name from its own read, so a name with spaces in it is one name and not two columns", () => {
    const names = parsePsNames(MAC_PS_NAMES);
    expect(names.get(4213)).toBe("Google Chrome Helper");
    expect(names.get(4212)).toBe("claude");
    expect(names.get(9999)).toBeUndefined();
    expect(parsePsNames("  4213 \n")).toEqual(new Map());
  });

  it("truncates a command line by bytes, the same budget the guest's road reads out of /proc", () => {
    const row = (args: string) => parsePs(`      7       1 S root      100 00:00:01 Mon Sep  7 08:07:19 2026 ${args}\n`)[0]!;
    expect(row("x".repeat(300)).cmdline.length).toBe(PROC_CMDLINE_BYTES);
    // Two bytes to the character, so the same budget holds half as many of them: the cut is by bytes, not letters.
    // A character the cut lands inside decodes to one replacement, as it does on the guest's road.
    const wide = row(`node ${"\u00e9".repeat(300)}`).cmdline;
    expect(wide.length).toBeLessThan(PROC_CMDLINE_BYTES);
    expect(Buffer.byteLength(wide, "utf8")).toBeLessThanOrEqual(PROC_CMDLINE_BYTES + 2);
  });

  it("lists this computer's own processes, this test among them, named and with the daemon's ptys marked", async () => {
    const source = new LocalProcSource({ ports: async () => [] });
    const scan = await source.scan({ at: Date.now(), elapsedMs: 0, pty: pid => (pid === process.pid ? "pty_1" : undefined) });
    const self = scan.procs.find(p => p.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.user).toBe(userInfo().username);
    expect(self!.cmdline).not.toBe("");
    expect(self!.comm).not.toBe("");
    expect(self!.pty).toBe("pty_1");
    expect(self!.startedAt).toBeLessThanOrEqual(Date.now());
    expect(scan.total).toBeGreaterThanOrEqual(scan.procs.length);
    expect(scan.procs.every(p => p.rss >= 0 && p.cpu >= 0)).toBe(true);
  });

  it("asks ps for the whole line, whatever window it thinks it is printing into", async () => {
    // ps formats to a window: a Mac's, with no terminal on any of its streams, falls back to 79 columns and cuts
    // every row there, and a daemon has pipes for streams. procps cuts the same way when COLUMNS says so, which is
    // how this box can hold the rule at all.
    const tail = "wsp-whole-line-marker";
    // A loop, not a simple command: bash execs itself away for the latter, and it is bash's own long argv this reads.
    const long = spawn("bash", ["-c", `while :; do sleep 5; done # ${"x".repeat(100)} ${tail}`]);
    burning = long;
    const source = new LocalProcSource({ ports: async () => [] });
    const before = process.env["COLUMNS"];
    process.env["COLUMNS"] = "79";
    try {
      const row = await scanUntil(source, long.pid!, "a row at all", r => r !== undefined);
      expect(row.cmdline).toContain(tail);
      expect(row.cmdline.length).toBeGreaterThan(120);
    } finally {
      if (before === undefined) delete process.env["COLUMNS"];
      else process.env["COLUMNS"] = before;
    }
  }, 20_000);

  it("a machine whose ps says nothing at all is refused, so no pane reads an empty table as a fact", async () => {
    const source = new LocalProcSource({ ports: async () => [], user: "no-such-person-here" });
    await expect(source.scan({ at: Date.now(), elapsedMs: 0, pty: () => undefined })).rejects.toThrow();
  });

  it("the cpu column is the window just passed, not the whole life of the process", async () => {
    const source = new LocalProcSource({ ports: async () => [] });
    // This test's own process has burned seconds of cpu since it started; ps's own %cpu would report that average
    // for ever. The first scan has no window to divide by, so every row reads zero.
    const first = await source.scan({ at: Date.now(), elapsedMs: 0, pty: () => undefined });
    expect(first.procs.find(p => p.pid === process.pid)!.cpu).toBe(0);

    // A child that burns a core until this test stops it, so the burn lasts exactly as long as it takes to show up
    // in a reading, however much of this box the rest of it is using.
    burnDir = mkdtempSync(join(tmpdir(), "wsp-burn-"));
    const stop = join(burnDir, "stop");
    const burn = spawn("bash", ["-c", `while [ ! -f ${stop} ]; do :; done; sleep 300`]);
    burning = burn;

    // Busy in the window it burned in.
    const spent = await scanUntil(source, burn.pid!, "busy in a window", row => row !== undefined && row.cpu > 0);
    expect(spent.cpu).toBeGreaterThan(0);

    // And nothing in a window it did not: the delta is zero once it stops, whatever it burned before.
    writeFileSync(stop, "");
    const idle = await scanUntil(source, burn.pid!, "idle in a window", row => row !== undefined && row.cpu === 0);
    expect(idle.cpu).toBe(0);
    // Still zero in the window after that, where a whole-life average would still be reporting the burn.
    const after = await scanUntil(source, burn.pid!, "a row at all", row => row !== undefined);
    expect(after.cpu).toBe(0);
  }, 60_000);

  it("inspects one of them: its ports off the ports road, its children out of the scan, and nothing for a pid that is gone", async () => {
    const source = new LocalProcSource({ ports: async () => [{ port: 8080, pid: process.pid, uid: 0, loopback: false }, { port: 22, pid: 1, uid: 0, loopback: false }] });
    const scan = await source.scan({ at: Date.now(), elapsedMs: 0, pty: () => undefined });
    const kid = scan.procs.find(p => p.ppid === process.pid);
    const reply = await source.inspect(process.pid, scan.procs);
    expect(reply.pid).toBe(process.pid);
    expect(reply.ports).toEqual([8080]);
    // ps carries no thread count on macOS, so no kind reads one here and the field is left off rather than guessed.
    expect(reply.threads).toBeUndefined();
    if (kid !== undefined) expect(reply.children).toContain(kid.pid);
    await expect(source.inspect(2 ** 22 + 1, scan.procs)).rejects.toThrow(OpError);
  });
});

describe("the kind table", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("has a module for every kind whose machines carry a daemon and say they serve the reading", () => {
    for (const kind of WorkspaceKind.options) {
      if (!kindWords(kind).daemon) continue;
      expect([kind, KIND_READINGS[kind] !== undefined]).toEqual([kind, servesReading(kind, "metrics")]);
      expect([kind, KIND_READINGS[kind] !== undefined]).toEqual([kind, servesReading(kind, "processes")]);
    }
    expect(readingsFor("local")).toBeDefined();
    expect(readingsFor("cloud")).toBeDefined();
  });

  it("refuses a kind with no module in the words the pane prints, so no pane waits on a stream that never comes", () => {
    // Every kind in the enum has a module today, so the guard is proved against a kind that is not one: what it
    // is for is a kind added to the enum without a row here.
    const missing = "plan9" as WorkspaceKind;
    expect(() => readingsFor(missing)).toThrow(/^not on this kind/);
    try {
      readingsFor(missing);
    } catch (e) {
      expect((e as OpError).code).toBe("unsupported");
    }
  });

  it("gives a machine over ssh the same /proc modules a fork gets, since the daemon on it is the same daemon", () => {
    expect(readingsFor("ssh")).toBe(readingsFor("cloud"));
  });

  it("picks a place's two modules by the system it is on, which is the one platform switch there is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-place-readings-"));
    made.push(dir);
    const opts = { root: dir, workFolder: dir, ports: async () => [], platform: "linux" };
    const place = readingsFor("place");
    // On Linux a place reads its own /proc, as a fork does; a fork's own modules are the same objects.
    const procRoot = mkdtempSync(join(tmpdir(), "wsp-place-proc-"));
    made.push(procRoot);
    const onLinux = place.metrics({ ...opts, procRoot });
    const forked = readingsFor("cloud").metrics({ ...opts, procRoot });
    expect(onLinux.constructor).toBe(forked.constructor);
    // Elsewhere it reads its own host with os, df and ps, which is what answers on a Mac: the /proc road reads
    // nothing there and left both panes at pending.
    const mine = place.processes({ ...opts, platform: "darwin" });
    expect(mine).toBeInstanceOf(LocalProcSource);
    expect(readingsFor("place").processes({ ...opts, platform: "linux", procRoot })).not.toBeInstanceOf(LocalProcSource);
  });
});
