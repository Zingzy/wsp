import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { choosePorts } from "../src/ports.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDaemon } from "../src/local-daemon.js";

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
    daemon = await LocalDaemon.start({ root });
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
    daemon = await LocalDaemon.start({ root });
    expect(hostPorts).not.toContain(daemon.port);
    // The host's own pick, with both ports named: it binds exactly the pair asked for, nothing taken, nothing stepped over.
    expect(await choosePorts({ port: hostPorts[0]!, wsPort: hostPorts[1]!, named: true })).toEqual({ ports: { port: hostPorts[0], wsPort: hostPorts[1] } });
    // Nothing of the daemon's lands on disk beside the host's files: the folder holds the inbox it made and nothing else.
    expect(readdirSync(root)).toEqual([".wsp-inbox"]);
  });

  it("serves the files under the workspace folder", async () => {
    writeFileSync(join(root, "hello.txt"), "hi");
    daemon = await LocalDaemon.start({ root });
    const link = daemon.link();
    await link.ready;
    const listing = (await link.request("fs.list", { path: root })) as { entries: { name: string }[] };
    expect(listing.entries.map(e => e.name)).toContain("hello.txt");
    link.close();
  });

  it("runs a pty in the workspace folder", async () => {
    daemon = await LocalDaemon.start({ root });
    const link = daemon.link();
    await link.ready;
    const created = (await link.request("pty.create", { cwd: root })) as { ptyId: string; pid: number };
    expect(created.pid).toBeGreaterThan(0);
    const listed = (await link.request("pty.list")) as { ptys: { id: string }[] };
    expect(listed.ptys.map(p => p.id)).toContain(created.ptyId);
    link.close();
  });
});
