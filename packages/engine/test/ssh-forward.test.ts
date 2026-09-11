// SPDX-License-Identifier: AGPL-3.0-only
// The road to a daemon on a machine reached over ssh. The child that holds it
// is this host's own: one per machine, reused by every dial, and the only
// thing ever killed is the pid recorded when it was started.
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { LOOPBACK } from "@wsp/protocol";
import { SshForwards, sshForwardArgs, type ForwardChild, type ForwardSpawner, type SshReach } from "../src/index.js";

const REACH: SshReach = { user: "maya", host: "box", port: 2222, keyPath: "/tmp/k" };

/** A forward child that never leaves this computer: it listens on the local port the real one would carry, so
 * the readiness wait is the real one, and it records the pid it was given and whether that pid was killed. */
function fakeForwards(): { spawner: ForwardSpawner; started: { pid: number; localPort: number; remotePort: number; killed: boolean }[] } {
  const started: { pid: number; localPort: number; remotePort: number; killed: boolean }[] = [];
  let next = 5000;
  const spawner: ForwardSpawner = (_reach, localPort, remotePort) => {
    const row = { pid: ++next, localPort, remotePort, killed: false };
    started.push(row);
    const server: Server = createServer(socket => socket.destroy());
    server.listen(localPort, LOOPBACK);
    const ended = new Promise<string>(done => server.once("close", () => done("")));
    const child: ForwardChild = {
      pid: row.pid,
      ended,
      kill: () => {
        row.killed = true;
        server.close();
      },
    };
    return child;
  };
  return { spawner, started };
}

describe("the forward to a machine's daemon", () => {
  it("is one child per machine, reused by every dial after the first", async () => {
    const { spawner, started } = fakeForwards();
    const forwards = new SshForwards({ spawn: spawner });
    try {
      const first = await forwards.forward("ssh://maya@box:2222", REACH, 42891);
      const again = await forwards.forward("ssh://maya@box:2222", REACH, 42891);
      expect(again.localPort).toBe(first.localPort);
      expect(started).toHaveLength(1);
      // Another machine is another child, never the same one.
      await forwards.forward("ssh://maya@other:22", { user: "maya", host: "other", port: 22 }, 7070);
      expect(started).toHaveLength(2);
      expect(started[1]!.localPort).not.toBe(first.localPort);
    } finally {
      await forwards.close();
    }
  });

  it("carries a local port on this computer to the port the daemon bound on the machine's own loopback", async () => {
    const { spawner, started } = fakeForwards();
    const forwards = new SshForwards({ spawn: spawner });
    try {
      const { localPort } = await forwards.forward("ssh://maya@box:2222", REACH, 42891);
      expect(started[0]).toMatchObject({ localPort, remotePort: 42891 });
      expect(localPort).toBeGreaterThan(0);
      expect(localPort).not.toBe(42891);
    } finally {
      await forwards.close();
    }
  });

  it("replaces the child when the daemon came back on another port, so no dial lands on a port nothing holds", async () => {
    const { spawner, started } = fakeForwards();
    const forwards = new SshForwards({ spawn: spawner });
    try {
      await forwards.forward("ssh://maya@box:2222", REACH, 42891);
      await forwards.forward("ssh://maya@box:2222", REACH, 51000);
      expect(started).toHaveLength(2);
      expect(started[0]!.killed).toBe(true);
      expect(started[1]!.remotePort).toBe(51000);
    } finally {
      await forwards.close();
    }
  });

  it("kills the pid it recorded and nothing else, when the workspace goes and when the host closes", async () => {
    const { spawner, started } = fakeForwards();
    const forwards = new SshForwards({ spawn: spawner });
    await forwards.forward("ssh://maya@box:2222", REACH, 42891);
    await forwards.forward("ssh://maya@other:22", { user: "maya", host: "other", port: 22 }, 7070);
    expect(await forwards.pidOf("ssh://maya@box:2222")).toBe(started[0]!.pid);

    await forwards.drop("ssh://maya@box:2222");
    expect(started[0]!.killed).toBe(true);
    // The other machine's forward is another workspace's and is left alone.
    expect(started[1]!.killed).toBe(false);
    // The record goes with the child, so a dial after a drop makes a fresh one rather than answering with a
    // port nothing listens on.
    expect(await forwards.pidOf("ssh://maya@box:2222")).toBeUndefined();

    await forwards.close();
    expect(started[1]!.killed).toBe(true);
    await expect(forwards.forward("ssh://maya@box:2222", REACH, 42891)).rejects.toThrow("this host is closing");
  });

  it("opens a fresh child once the one it held ended on its own", async () => {
    const { spawner, started } = fakeForwards();
    const forwards = new SshForwards({ spawn: spawner });
    try {
      const first = await forwards.forward("ssh://maya@box:2222", REACH, 42891);
      // The machine rebooted, or the connection dropped past its keepalives: the child is gone and its port with it.
      await forwards.drop("ssh://maya@box:2222");
      const second = await forwards.forward("ssh://maya@box:2222", REACH, 42891);
      expect(started).toHaveLength(2);
      expect(second.localPort).not.toBe(0);
      void first;
    } finally {
      await forwards.close();
    }
  });

  it("says so rather than hanging when the child never carries", async () => {
    // A child that ends at once, which is what a local port taken between picking it and binding it gives under
    // ExitOnForwardFailure.
    const spawner: ForwardSpawner = () => ({ pid: 99, ended: Promise.resolve("bind: Address already in use"), kill: () => {} });
    const forwards = new SshForwards({ spawn: spawner, readyMs: 500, pollMs: 5 });
    await expect(forwards.forward("ssh://maya@box:2222", REACH, 42891)).rejects.toThrow("closed as it opened: bind: Address already in use");
    // Nothing is held for a forward that never opened, so the next dial tries again.
    expect(await forwards.pidOf("ssh://maya@box:2222")).toBeUndefined();
  });
});

describe("the forward's own connection", () => {
  it("never rides the master every command rides, so the pid this host recorded is the whole road", () => {
    const args = sshForwardArgs(REACH, 5555, 42891);
    // A forward asked for over a master belongs to the master and outlives the child that asked for it (measured
    // 2026-09-11 against OpenSSH 10.2: the port still answered after the recorded pid was killed).
    expect(args).toContain("ControlMaster=no");
    expect(args).toContain("ControlPath=none");
    expect(args).not.toContain("ControlMaster=auto");
  });

  it("carries only between the two loopbacks, asks for no shell, and ends rather than binding something else", () => {
    const args = sshForwardArgs(REACH, 5555, 42891);
    expect(args.slice(args.indexOf("-L"), args.indexOf("-L") + 2)).toEqual(["-L", "127.0.0.1:5555:127.0.0.1:42891"]);
    expect(args).toContain("-N");
    expect(args).toContain("ExitOnForwardFailure=yes");
    // A child whose machine went away ends, so the next dial makes a fresh one instead of carrying to nothing.
    expect(args).toContain("ServerAliveInterval=15");
    // The dial itself is the one every ssh child of this host makes.
    expect(args).toContain("BatchMode=yes");
    expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", "2222"]);
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", "/tmp/k"]);
    expect(args.at(-1)).toBe("maya@box");
  });
});
