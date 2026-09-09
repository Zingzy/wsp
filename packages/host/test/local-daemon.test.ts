// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { choosePorts } from "../src/ports.js";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectDaemon } from "@wsp/runtime";
import type { DaemonEvent, ProcInspectReply, ProcSnapshot, SysSample } from "@wsp/protocol";
import { LocalDaemon } from "../src/local-daemon.js";

/** The daemon samples every two seconds, so the first of either event is one interval out. */
async function waitForEvent(events: DaemonEvent[], type: string): Promise<DaemonEvent> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const found = events.find(e => e.type === type);
    if (found !== undefined) return found;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`no ${type} event in time`);
}

describe("local daemon", () => {
  let root: string;
  let daemon: LocalDaemon | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localdaemon-"));
  });
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("boots on loopback and answers the same link a cloud workspace's daemon is reached by", async () => {
    daemon = await LocalDaemon.start({ root, workFolder: root });
    expect(daemon.port).toBeGreaterThan(0);
    const link = daemon.link();
    await link.ready;
    await link.request("ping");
    link.close();
  });

  it("binds a free ephemeral port the host's own port check never sees as a clash, and its token stays in memory", async () => {
    // Two ports of the host's own, free right now, standing in for its app and runtime ports.
    const free = async (): Promise<number> =>
      new Promise(resolve => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => {
          const port = (s.address() as { port: number }).port;
          s.close(() => resolve(port));
        });
      });
    const hostPorts = [await free(), await free()];
    daemon = await LocalDaemon.start({ root, workFolder: root });
    expect(hostPorts).not.toContain(daemon.port);
    // The host's own pick, with both ports named: it binds exactly the pair asked for, nothing taken, nothing stepped over.
    expect(await choosePorts({ port: hostPorts[0]!, wsPort: hostPorts[1]!, named: true })).toEqual({ ports: { port: hostPorts[0], wsPort: hostPorts[1] } });
    // Nothing of the daemon's lands on disk beside the host's files: the folder holds the inbox it made and nothing else.
    expect(readdirSync(root)).toEqual([".wsp-inbox"]);
  });

  it("hands out one road for the panes and the probe: an http route the probe fetches and every link turns into ws, with the token beside it", async () => {
    daemon = await LocalDaemon.start({ root, workFolder: root });
    const road = daemon.road;
    expect(road.url).toBe(`http://127.0.0.1:${daemon.port}`);
    expect(road.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(road.daemonToken).toMatch(/^[0-9a-f]{48}$/);
    // The status probe fetches that url; a WebSocket server answers a plain GET 426, which is what it reads as a daemon.
    expect((await fetch(road.url)).status).toBe(426);
    // The browser's link dials the same url as ws, with the token in the first frame.
    const link = connectDaemon({ previewUrl: road.url, token: road.daemonToken!, onEvent: () => {} });
    await link.ready;
    link.close();
  });

  it("serves the files under the workspace folder", async () => {
    writeFileSync(join(root, "hello.txt"), "hi");
    daemon = await LocalDaemon.start({ root, workFolder: root });
    const link = daemon.link();
    await link.ready;
    const listing = (await link.request("fs.list", { path: root })) as { entries: { name: string }[] };
    expect(listing.entries.map(e => e.name)).toContain("hello.txt");
    link.close();
  });

  it("answers the Live rows and the Processes tab off this computer itself, with a sample and a snapshot that holds this process", async () => {
    daemon = await LocalDaemon.start({ root, workFolder: root });
    const events: DaemonEvent[] = [];
    const link = daemon.link(e => events.push(e));
    await link.ready;
    // The watches answer only once this computer has been read, so an ok here is already the module working.
    await link.request("sys.watch");
    await link.request("proc.watch");
    const sample = await waitForEvent(events, "sys.sample");
    expect((sample as SysSample).mem.total).toBe(totalmem());
    expect((sample as SysSample).disk.total).toBeGreaterThan(0);
    const snapshot = await waitForEvent(events, "proc.snapshot");
    expect((snapshot as ProcSnapshot).procs.some(p => p.pid === process.pid)).toBe(true);
    // Which modules answered, not merely that something did: this computer's processes module reads ps, which has
    // no thread column on macOS, so it leaves the field off where the guest's /proc module always sets it. Without
    // that, a host that forgot to say which kind it serves would pass this on Linux, where /proc exists.
    const inspect = (await link.request("proc.inspect", { pid: process.pid })) as ProcInspectReply;
    expect(inspect.pid).toBe(process.pid);
    expect(inspect.threads).toBeUndefined();
    link.close();
  }, 20_000);

  it("runs a pty in the workspace folder", async () => {
    daemon = await LocalDaemon.start({ root, workFolder: root });
    const link = daemon.link();
    await link.ready;
    const created = (await link.request("pty.create", { cwd: root })) as { ptyId: string; pid: number };
    expect(created.pid).toBeGreaterThan(0);
    const listed = (await link.request("pty.list")) as { ptys: { id: string }[] };
    expect(listed.ptys.map(p => p.id)).toContain(created.ptyId);
    link.close();
  });
});
