import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseProcNetTcp, PortWatcher, type ListeningPort } from "../src/ports.js";

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
