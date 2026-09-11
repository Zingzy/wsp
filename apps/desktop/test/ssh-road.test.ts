// SPDX-License-Identifier: AGPL-3.0-only
// The ssh road as the main process drives it: one login to read the lock,
// the service started when nothing serves, the box's port forwarded to a free
// one here with the forward's pid recorded, and wsp pair read for its code.
// Every ssh is a fake child here; the words and the pids are what is checked.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { noWspLine, sshFailedLine, sshRoad, type ChildLike, type SshRoadDeps } from "../src/ssh-road.js";

const LOCK = { pid: 12, port: 4400, wsPort: 4410, address: "127.0.0.1", startedAt: "2026-09-11T10:00:00.000Z" };

class FakeChild extends EventEmitter implements ChildLike {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(): boolean {
    this.killed = true;
    this.end(0);
    return true;
  }
  say(out: string, code = 0): void {
    this.stdout.write(out);
    this.end(code);
  }
  fail(err: string, code = 255): void {
    this.stderr.write(err);
    this.end(code);
  }
  end(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("exit", code, null));
  }
}

/** What a fake ssh answers, by the remote command it was handed. */
type Script = (args: string[], child: FakeChild) => void;

function fakeDeps(script: Script, over: Partial<SshRoadDeps> = {}): SshRoadDeps & { children: FakeChild[]; spawned: string[][] } {
  const children: FakeChild[] = [];
  const spawned: string[][] = [];
  let pid = 100;
  return {
    sshCommand: "ssh",
    spawn: (command, args) => {
      const child = new FakeChild(++pid);
      children.push(child);
      spawned.push([command, ...args]);
      setImmediate(() => script(args, child));
      return child;
    },
    freePort: async () => 52001,
    serves: async () => true,
    waitMs: 2_000,
    children,
    spawned,
    ...over,
  };
}

const remote = (args: string[]): string => args[args.length - 1]!;
const isForward = (args: string[]): boolean => args.includes("-N");

describe("sshRoad", () => {
  it("a box without wsp answers the one sentence with the install line, and no ssh is left running", async () => {
    const d = fakeDeps((_args, child) => child.say("no-wsp\n"));
    const road = sshRoad(d);
    await expect(road.open({ address: "maya@box", port: 2222 })).rejects.toThrow(noWspLine("maya@box"));
    expect(noWspLine("maya@box")).toBe("wsp is not installed on maya@box: run npm i -g @zingzy/wsp there, then connect again.");
    expect(road.pids()).toEqual([]);
    expect(d.spawned[0]!.slice(0, 7)).toEqual(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p"]);
    expect(d.spawned[0]).toContain("2222");
    expect(d.spawned[0]).toContain("maya@box");
  });

  it("a login ssh refuses is said with ssh's own words", async () => {
    const d = fakeDeps((_args, child) => child.fail("maya@box: Permission denied (publickey).\n"));
    await expect(sshRoad(d).open({ address: "maya@box" })).rejects.toThrow(sshFailedLine("maya@box", "maya@box: Permission denied (publickey)."));
    expect(d.spawned[0]).not.toContain("-p");
  });

  it("with a host serving, forwards its port here, pairs, and records the forward's pid until it is closed", async () => {
    const d = fakeDeps((args, child) => {
      if (isForward(args)) return;
      const command = remote(args);
      if (command.includes("host.lock")) return child.say(`lock ${JSON.stringify(LOCK)}\n`);
      if (command === "wsp pair") return child.say("code        ABCD-EFGH\nexpires     in 10m\nopen        http://127.0.0.1:4400\n");
      child.fail(`unexpected: ${command}`);
    });
    const road = sshRoad(d);
    const opened = await road.open({ address: "maya@box", port: 2222 });
    expect(opened).toEqual({ url: "http://127.0.0.1:52001", code: "ABCD-EFGH", hostPort: 4400 });
    const forward = d.spawned.find(isForward)!;
    expect(forward).toContain("127.0.0.1:52001:127.0.0.1:4400");
    expect(road.pids()).toEqual([d.children.find(c => !c.exitCode && c.exitCode === null)!.pid]);
    // Nothing started a service: the lock named a live host.
    expect(d.spawned.some(a => remote(a).includes("--service"))).toBe(false);
    road.closeAll();
    expect(d.children.filter(c => c.killed)).toHaveLength(1);
    await new Promise(r => setImmediate(r));
    expect(road.pids()).toEqual([]);
  });

  it("with nothing serving, starts wsp as a service on the box's own computer alone, then reads the lock it wrote", async () => {
    let started = false;
    const d = fakeDeps((args, child) => {
      if (isForward(args)) return;
      const command = remote(args);
      if (command.includes("host.lock")) return child.say(started ? `lock ${JSON.stringify(LOCK)}\n` : "none\n");
      if (command === "wsp up --service --listen 127.0.0.1 --port 0") {
        started = true;
        return child.say("app         http://127.0.0.1:4400\n");
      }
      if (command === "wsp pair") return child.say("code        ABCDEFGH\n");
      child.fail(`unexpected: ${command}`);
    });
    const road = sshRoad(d);
    expect(await road.open({ address: "maya@box" })).toEqual({ url: "http://127.0.0.1:52001", code: "ABCDEFGH", hostPort: 4400 });
    expect(d.spawned.map(remote).filter(c => c.startsWith("wsp"))).toEqual(["wsp up --service --listen 127.0.0.1 --port 0", "wsp pair"]);
    road.closeAll();
  });

  it("a service the box refuses to start is said in the box's words", async () => {
    const d = fakeDeps((args, child) => {
      const command = remote(args);
      if (command.includes("host.lock")) return child.say("none\n");
      child.fail("wsp up --service: nothing to serve; run wsp init first\n", 1);
    });
    await expect(sshRoad(d).open({ address: "maya@box" })).rejects.toThrow(/^wsp up --service: nothing to serve; run wsp init first$/);
  });

  it("a forward that dies before the page answers is said with its words, and a second forward for one login is not made", async () => {
    const d = fakeDeps((args, child) => {
      if (isForward(args)) return child.fail("bind [127.0.0.1]:52001: Address already in use\n");
      const command = remote(args);
      if (command.includes("host.lock")) return child.say(`lock ${JSON.stringify(LOCK)}\n`);
    }, { serves: async () => false });
    const road = sshRoad(d);
    await expect(road.open({ address: "maya@box" })).rejects.toThrow(sshFailedLine("maya@box", "bind [127.0.0.1]:52001: Address already in use"));
    expect(road.pids()).toEqual([]);
  });

  it("the same login asked for twice keeps its one forward, and prefers the local port it is asked for", async () => {
    const d = fakeDeps(() => {}, { freePort: vi.fn(async () => 52009) });
    const road = sshRoad(d);
    expect(await road.forward({ address: "maya@box" }, 4400, 52001)).toBe("http://127.0.0.1:52001");
    expect(await road.forward({ address: "maya@box" }, 4400, 52001)).toBe("http://127.0.0.1:52001");
    expect(d.spawned).toHaveLength(1);
    expect(d.freePort).not.toHaveBeenCalled();
    road.closeForward("maya@box");
    expect(await road.forward({ address: "maya@box" }, 4400)).toBe("http://127.0.0.1:52009");
    road.closeAll();
  });
});
