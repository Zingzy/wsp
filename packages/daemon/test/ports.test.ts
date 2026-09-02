import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseProcNetTcp, PortWatcher, procNetTcpSource, type ListeningPort } from "../src/ports.js";

// Fixture provenance: hand-written from the documented /proc/net/tcp format
// (proc(5); kernel net/ipv4/tcp_ipv4.c get_tcp4_sock printf layout), since no
// Linux box was available at authoring time. 3 rows: 0.0.0.0:8080 LISTEN
// (inode 45678), 127.0.0.1:3000 LISTEN (inode 45700), and one ESTABLISHED
// connection that parsers must ignore. Swap in a real capture from the first
// VM run when available.
const fixture = readFileSync(join(import.meta.dirname, "fixtures", "proc-net-tcp.txt"), "utf8");

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
    let snapshot: ListeningPort[] = [{ port: 8080, pid: 123, inode: 45678, uid: 0 }];
    const w = new PortWatcher(async () => snapshot);
    const opened: number[] = [];
    const closed: number[] = [];
    w.on("port.open", e => opened.push(e.port));
    w.on("port.close", e => closed.push(e.port));

    await w.poll();
    snapshot = [
      { port: 8080, pid: 123, inode: 45678, uid: 0 },
      { port: 3000, pid: 456, inode: 45700, uid: 1000 },
    ];
    await w.poll();
    snapshot = [{ port: 3000, pid: 456, inode: 45700, uid: 1000 }];
    await w.poll();
    await w.poll(); // steady state: no repeat events

    expect(opened).toEqual([8080, 3000]);
    expect(closed).toEqual([8080]);
    expect(w.current().map(p => p.port)).toEqual([3000]);
  });
});

/** A /proc lookalike: net/tcp from the fixture, pid 123 owning inode 45678 with
 * comm "node", pid 456 owning inode 45700 with no comm file at all. */
function fakeProcRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-proc-"));
  mkdirSync(join(root, "net"));
  writeFileSync(join(root, "net", "tcp"), fixture);
  mkdirSync(join(root, "123", "fd"), { recursive: true });
  symlinkSync("socket:[45678]", join(root, "123", "fd", "3"));
  writeFileSync(join(root, "123", "comm"), "node\n");
  mkdirSync(join(root, "456", "fd"), { recursive: true });
  symlinkSync("socket:[45700]", join(root, "456", "fd", "5"));
  return root;
}

describe("procNetTcpSource against a fake proc root", () => {
  const root = fakeProcRoot();
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("names the listening process from /proc/<pid>/comm and leaves it unset when comm is unreadable", async () => {
    const rows = await procNetTcpSource(root)();
    expect(rows).toEqual([
      { port: 8080, pid: 123, inode: 45678, uid: 0, process: "node" },
      { port: 3000, pid: 456, inode: 45700, uid: 1000 },
    ]);
  });

  it("port.open carries process when the row has one", async () => {
    const w = new PortWatcher(procNetTcpSource(root));
    const opened: unknown[] = [];
    w.on("port.open", e => opened.push(e));
    await w.poll();
    expect(opened).toEqual([
      { type: "port.open", port: 8080, pid: 123, process: "node" },
      { type: "port.open", port: 3000, pid: 456 },
    ]);
  });
});
