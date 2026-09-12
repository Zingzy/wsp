import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DaemonEvent } from "@wsp/protocol";
import { isLoopbackHost, lsofSource, parseLsofListeners, parseProcNetTcp, portSourceFor, PortWatcher, procNetTcpSource, type ListeningPort } from "../src/ports.js";
import { fixture as readFixture } from "./fixtures.js";

// Fixture provenance: hand-written from the documented /proc/net/tcp format
// (proc(5); kernel net/ipv4/tcp_ipv4.c get_tcp4_sock printf layout), since no
// Linux box was available at authoring time. 3 rows: 0.0.0.0:8080 LISTEN
// (inode 45678), 127.0.0.1:3000 LISTEN (inode 45700), and one ESTABLISHED
// connection that parsers must ignore. Swap in a real capture from the first
// VM run when available.
const fixture = readFixture("proc-net-tcp.txt");

describe("parseProcNetTcp", () => {
  it("returns LISTEN ports with pids resolved through the inode map", () => {
    const rows = parseProcNetTcp(fixture, new Map([[45678, 123], [45700, 456]]));
    expect(rows).toMatchObject([
      { port: 8080, pid: 123 },
      { port: 3000, pid: 456 },
    ]);
  });
  it("filters non-LISTEN rows and survives a missing inode map", () => {
    const rows = parseProcNetTcp(fixture);
    expect(rows.map(r => r.port)).toEqual([8080, 3000]);
    expect(rows[0]).toMatchObject({ pid: null, inode: 45678, uid: 0 });
    expect(rows[1]).toMatchObject({ pid: null, inode: 45700, uid: 1000 });
  });
});

describe("PortWatcher", () => {
  it("emits port.open and port.close on diffs between polls", async () => {
    let snapshot: ListeningPort[] = [{ port: 8080, pid: 123, inode: 45678, uid: 0, loopback: false }];
    const w = new PortWatcher(async () => snapshot);
    const opened: number[] = [];
    const closed: number[] = [];
    w.on("port.open", e => opened.push(e.port));
    w.on("port.close", e => closed.push(e.port));

    await w.poll();
    // The first poll seeds what is already there without events; only changes after it are events.
    expect(opened).toEqual([]);
    expect(w.current().map(p => p.port)).toEqual([8080]);
    snapshot = [
      { port: 8080, pid: 123, inode: 45678, uid: 0, loopback: false },
      { port: 3000, pid: 456, inode: 45700, uid: 1000, loopback: true },
    ];
    await w.poll();
    snapshot = [{ port: 3000, pid: 456, inode: 45700, uid: 1000, loopback: true }];
    await w.poll();
    await w.poll(); // steady state: no repeat events

    expect(opened).toEqual([3000]);
    expect(closed).toEqual([8080]);
    expect(w.current().map(p => p.port)).toEqual([3000]);
  });
});

describe("PortWatcher first poll and its subscriber", () => {
  it("a poll awaited while the seeding poll is in flight waits for it, so the first ports.watch reply lists what was already listening", async () => {
    // The real source walks /proc and takes longer than a microtask; the seed must not be lost to that.
    const slow = (): Promise<ListeningPort[]> => new Promise(r => setTimeout(() => r([{ port: 3000, pid: 1, inode: 1, uid: 0, loopback: true }]), 40));
    const w = new PortWatcher(slow, { intervalMs: 60_000 });
    const opened: number[] = [];
    w.on("port.open", e => opened.push(e.port));
    w.start();
    await w.poll();
    expect(w.current().map(p => p.port)).toEqual([3000]);
    expect(opened).toEqual([]);
    w.stop();
  });
});

/** A /proc lookalike: net/tcp from the fixture, pid 123 owning inode 45678 with
 * comm "node" and a cmdline, pid 456 owning inode 45700 with no comm file at all. */
function fakeProcRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-proc-"));
  mkdirSync(join(root, "net"));
  writeFileSync(join(root, "net", "tcp"), fixture);
  mkdirSync(join(root, "123", "fd"), { recursive: true });
  symlinkSync("socket:[45678]", join(root, "123", "fd", "3"));
  writeFileSync(join(root, "123", "comm"), "node\n");
  writeFileSync(join(root, "123", "cmdline"), ["node", "server.js", "--port", "8080", ""].join("\0"));
  mkdirSync(join(root, "456", "fd"), { recursive: true });
  symlinkSync("socket:[45700]", join(root, "456", "fd", "5"));
  return root;
}

describe("procNetTcpSource against a fake proc root", () => {
  const root = fakeProcRoot();
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("names the listening process from /proc/<pid>/comm and its argv from cmdline, leaving both unset when unreadable", async () => {
    const rows = await procNetTcpSource(root)();
    expect(rows).toEqual([
      { port: 8080, pid: 123, inode: 45678, uid: 0, process: "node", command: "node server.js --port 8080", loopback: false },
      { port: 3000, pid: 456, inode: 45700, uid: 1000, loopback: true },
    ]);
  });

  it("reads at most 512 bytes of cmdline and ends a cut argv with an ellipsis, so a long argv stays off the wire", async () => {
    const long = fakeProcRoot();
    writeFileSync(join(long, "456", "cmdline"), ["node", "-e", "x".repeat(4096), ""].join("\0"));
    try {
      const rows = await procNetTcpSource(long)();
      expect(rows[1]).toEqual({ port: 3000, pid: 456, inode: 45700, uid: 1000, command: `node -e ${"x".repeat(504)}…`, loopback: true });
      expect(rows[1]!.command).toHaveLength(513);
    } finally {
      rmSync(long, { recursive: true, force: true });
    }
  });

  it("port.open carries process when the row has one", async () => {
    // Seed with nothing listening so the fixture's rows are changes, not the first poll's baseline.
    let source = async (): Promise<ListeningPort[]> => [];
    const w = new PortWatcher(() => source());
    const opened: unknown[] = [];
    w.on("port.open", e => opened.push(e));
    await w.poll();
    source = procNetTcpSource(root);
    await w.poll();
    expect(opened).toEqual([
      { type: "port.open", port: 8080, pid: 123, process: "node", loopback: false },
      { type: "port.open", port: 3000, pid: 456, loopback: true },
    ]);
  });
});

/** The fixture with its 0.0.0.0:8080 row swapped for one whose socket inode no /proc/<pid>/fd names. */
const RESTARTED_ROW = fixture.split("\n").find(l => l.includes("45678"))!;
const withoutListener = fixture.replace(RESTARTED_ROW + "\n", "");
const restartedUnowned = fixture.replace(RESTARTED_ROW, RESTARTED_ROW.replace("45678", "45999"));

describe("PortWatcher across a listener restart on one port", () => {
  const root = fakeProcRoot();
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("emits close then open, and the open is a wire event whether or not the new owner's pid can be read", async () => {
    const w = new PortWatcher(procNetTcpSource(root), { alive: () => false, now: () => Date.parse("2026-09-05T12:04:00.000Z") });
    const events: unknown[] = [];
    w.on("port.open", e => events.push(e));
    w.on("port.close", e => events.push(e));
    await w.poll();
    expect(events).toEqual([]);

    writeFileSync(join(root, "net", "tcp"), withoutListener);
    rmSync(join(root, "123"), { recursive: true, force: true });
    await w.poll();
    expect(events).toEqual([{ type: "port.close", port: 8080, pid: 123, process: "node", command: "node server.js --port 8080", exited: true, at: "2026-09-05T12:04:00.000Z" }]);
    expect(DaemonEvent.safeParse(events[0]).success).toBe(true);

    writeFileSync(join(root, "net", "tcp"), restartedUnowned);
    await w.poll();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ type: "port.open", port: 8080, loopback: false });
    expect(DaemonEvent.safeParse(events[1]).success).toBe(true);
  });
});

describe("PortWatcher port.close detail", () => {
  const at = "2026-09-05T12:04:00.000Z";
  const held: ListeningPort = { port: 8412, pid: 53479, inode: 9, uid: 0, process: "python3", command: "python3 -m http.server 8412", loopback: false };
  const unowned: ListeningPort = { port: 3000, pid: null, inode: 10, uid: 0, loopback: false };

  async function closeAfter(rows: ListeningPort[], alive: (pid: number) => boolean): Promise<unknown[]> {
    let snapshot = rows;
    const w = new PortWatcher(async () => snapshot, { alive, now: () => Date.parse(at) });
    const closed: unknown[] = [];
    w.on("port.close", e => closed.push(e));
    await w.poll();
    snapshot = [];
    await w.poll();
    return closed;
  }

  it("a port seen with a pid closes with its holder, whether the pid exited, and the time", async () => {
    const asked: number[] = [];
    const closed = await closeAfter([held], pid => {
      asked.push(pid);
      return false;
    });
    expect(closed).toEqual([{ type: "port.close", port: 8412, pid: 53479, process: "python3", command: "python3 -m http.server 8412", exited: true, at }]);
    expect(asked).toEqual([53479]);
    expect(DaemonEvent.safeParse(closed[0]).success).toBe(true);
  });

  it("a holder still alive when its port closes is said to be running", async () => {
    const closed = await closeAfter([held], () => true);
    expect(closed[0]).toMatchObject({ pid: 53479, exited: false });
  });

  it("a port whose owner was never resolved closes plain, with only the time", async () => {
    const closed = await closeAfter([unowned], () => {
      throw new Error("never asked without a pid");
    });
    expect(closed).toEqual([{ type: "port.close", port: 3000, at }]);
    expect(DaemonEvent.safeParse(closed[0]).success).toBe(true);
  });
});

// Fixture provenance: hand-written from the documented lsof -F field output
// (lsof(8): a process set opens with p and carries c, u; each file set opens
// with f and carries n), since no macOS box was available at authoring time.
// Three processes: one on *:7000 and [::1]:5000, node on 127.0.0.1:3000 and
// [::1]:3000, one on 0.0.0.0:49152. Swap in a real capture from the first Mac
// run when available.
const lsofFixture = readFixture("lsof-listen.txt");

describe("loopback in a text address, as lsof prints it", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.0.0.2", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["0.0.0.0", false],
    ["192.168.1.1", false],
    ["::", false],
    ["fe80::1", false],
    ["::ffff:192.168.1.1", false],
    ["*", false],
    ["", false],
    ["not-an-address", false],
  ])("%s", (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });
});

describe("parseLsofListeners", () => {
  it("one row per listening socket, carrying its process set's pid, command name and uid", () => {
    expect(parseLsofListeners(lsofFixture)).toEqual([
      { port: 7000, pid: 712, uid: 501, process: "ControlCenter", loopback: false },
      { port: 5000, pid: 712, uid: 501, process: "ControlCenter", loopback: true },
      { port: 3000, pid: 1042, uid: 501, process: "node", loopback: true },
      { port: 3000, pid: 1042, uid: 501, process: "node", loopback: true },
      { port: 49152, pid: 88, uid: 0, process: "rapportd", loopback: false },
    ]);
  });

  it("no row carries an argv or a socket inode: lsof names neither", () => {
    for (const row of parseLsofListeners(lsofFixture)) {
      expect(row.command).toBeUndefined();
      expect(row.inode).toBeUndefined();
    }
  });

  it("a line that is not a field, and a name with no port, are skipped", () => {
    expect(parseLsofListeners("lsof: WARNING: can't stat()\np9\ncsh\nu0\nf3\nnpipe\nf4\nn127.0.0.1:8080\n")).toEqual([
      { port: 8080, pid: 9, uid: 0, process: "sh", loopback: true },
    ]);
  });
});

describe("the darwin road", () => {
  let fakeBin: string | undefined;
  const put = (script: string): void => {
    fakeBin = mkdtempSync(join(tmpdir(), "wsp-lsof-"));
    writeFileSync(join(fakeBin, "lsof"), script, { mode: 0o755 });
    chmodSync(join(fakeBin, "lsof"), 0o755);
    process.env["PATH"] = `${fakeBin}${delimiter}${process.env["PATH"] ?? ""}`;
  };
  const path = process.env["PATH"];
  afterEach(() => {
    process.env["PATH"] = path;
    if (fakeBin !== undefined) rmSync(fakeBin, { recursive: true, force: true });
    fakeBin = undefined;
  });

  it("asks lsof and folds its rows to one per port", async () => {
    put(`#!/bin/sh\ncat <<'OUT'\n${lsofFixture}OUT\n`);
    expect(await lsofSource()()).toEqual([
      { port: 7000, pid: 712, uid: 501, process: "ControlCenter", loopback: false },
      { port: 5000, pid: 712, uid: 501, process: "ControlCenter", loopback: true },
      { port: 3000, pid: 1042, uid: 501, process: "node", loopback: true },
      { port: 49152, pid: 88, uid: 0, process: "rapportd", loopback: false },
    ]);
  });

  it("lsof exiting non-zero with nothing listening reads as no ports, not as a failed poll", async () => {
    put("#!/bin/sh\nexit 1\n");
    await expect(lsofSource()()).resolves.toEqual([]);
  });
});

describe("the road per platform", () => {
  it("Linux reads /proc, macOS asks lsof, and a platform with no road reads empty rather than failing the pane", async () => {
    expect(portSourceFor("linux")).toBeInstanceOf(Function);
    expect(portSourceFor("darwin")).toBeInstanceOf(Function);
    await expect(portSourceFor("win32")()).resolves.toEqual([]);
  });
});
