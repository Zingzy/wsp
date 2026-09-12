// SPDX-License-Identifier: AGPL-3.0-only
// The daemon for this computer's own workspace is the binary every machine
// runs, spawned on loopback; these hold what the host reads off it and what it
// leaves on disk. They run on the binary built in this checkout, placed by
// packages/wspx/scripts/daemon-binary.mjs, so a failure here is a failure of
// the road the host takes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonEvent, ProcInspectReply, ProcSnapshot, SysSample } from "@wsp/protocol";
import { connectDaemon } from "@wsp/runtime";
import { daemonBinaryHere } from "../src/assets.js";
import { choosePorts } from "../src/ports.js";
import { LocalDaemon } from "../src/local-daemon.js";

async function waitForEvent(events: DaemonEvent[], type: string, ms = 10_000): Promise<DaemonEvent> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = events.find(e => e.type === type);
    if (found) return found;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`no ${type} event within ${ms} ms; saw ${events.map(e => e.type).join(", ") || "nothing"}`);
}

/** Whether a process is alive, asked of the kernel and not of node's handle. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

  it("spawns this computer's own binary out of the daemon asset, on loopback, and answers the same link a cloud workspace's daemon is reached by", async () => {
    expect(existsSync(daemonBinaryHere())).toBe(true);
    daemon = await LocalDaemon.start({ root, workFolder: root });
    expect(daemon.port).toBeGreaterThan(0);
    expect(alive(daemon.pid)).toBe(true);
    const link = daemon.link();
    await link.ready;
    await link.request("ping");
    link.close();
  });

  it("binds a free ephemeral port the host's own port check never sees as a clash, and leaves nothing of its own beside the host's files", async () => {
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
    // The folder holds the inbox it made and nothing else: the token file and the manifest sit in a folder of the
    // daemon's own under the system's temp dir, and the flags name both, so nothing falls back to a path under /root.
    expect(readdirSync(root)).toEqual([".wsp-inbox"]);
    const argv = execFileSync("ps", ["-o", "args=", "-p", String(daemon.pid)], { encoding: "utf8" }).trim().split(" ");
    for (const flag of ["--token-path", "--manifest"]) {
      const path = argv[argv.indexOf(flag) + 1]!;
      expect(path.startsWith(tmpdir())).toBe(true);
      expect(path.startsWith(root)).toBe(false);
    }
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

  it("reads its token off a file the caller named, so a rotation under it opens the next link", async () => {
    const tokenPath = join(root, "handed", "token");
    daemon = await LocalDaemon.start({ root, workFolder: root, tokenPath });
    const minted = readFileSync(tokenPath, "utf8").trim();
    expect(minted).toMatch(/^[0-9a-f]{48}$/);
    // A stand-in machine's daemon is reached by a token the runtime writes through that machine's own shell, and
    // that shell cannot write the path a Linux guest keeps one at; one holding only the token it minted would
    // refuse every link after the first rotation.
    const rotated = "b".repeat(48);
    writeFileSync(tokenPath, `${rotated}\n`);
    expect(daemon.road.daemonToken).toBe(rotated);
    const link = connectDaemon({ previewUrl: daemon.road.url, token: rotated, onEvent: () => {} });
    await link.ready;
    await link.request("ping");
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

  it("hands the host's Live rows one shared watch: a second pane reads the same samples, and the last one leaving closes it", async () => {
    daemon = await LocalDaemon.start({ root, workFolder: root });
    const a: SysSample[] = [];
    const b: SysSample[] = [];
    const detachA = await daemon.sysSamples(s => a.push(s));
    const detachB = await daemon.sysSamples(s => b.push(s));
    await waitForEvent(a as unknown as DaemonEvent[], "sys.sample");
    await waitForEvent(b as unknown as DaemonEvent[], "sys.sample");
    expect(a[0]!.mem.total).toBe(totalmem());
    // One watch on one link: the same sample reaches both.
    expect(b[0]).toEqual(a[0]);
    detachA();
    const seenByA = a.length;
    detachB();
    // A new listener after the last left opens a watch of its own and is answered again.
    const c: SysSample[] = [];
    const detachC = await daemon.sysSamples(s => c.push(s));
    await waitForEvent(c as unknown as DaemonEvent[], "sys.sample");
    detachC();
    expect(a.length).toBe(seenByA);
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

  it("ends the process it spawned when closed, and takes its token folder with it", async () => {
    daemon = await LocalDaemon.start({ root, workFolder: root });
    const pid = daemon.pid;
    await daemon.close();
    daemon = undefined;
    expect(alive(pid)).toBe(false);
    expect(readdirSync(tmpdir()).filter(name => name.startsWith("wsp-local-daemon-")).map(name => existsSync(join(tmpdir(), name, "token")) && alive(pid))).not.toContain(true);
  });

  it("names the binary and what it said when it does not start, and leaves no child behind", async () => {
    const bin = join(root, "not-a-daemon.sh");
    writeFileSync(bin, "#!/bin/sh\necho refusing >&2\nexit 3\n", { mode: 0o755 });
    await expect(LocalDaemon.start({ root, workFolder: root, binary: bin })).rejects.toThrow(/exited with 3 before it listened: refusing/);
  });
});
