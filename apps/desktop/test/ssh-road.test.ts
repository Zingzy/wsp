// SPDX-License-Identifier: AGPL-3.0-only
// The ssh road as the main process drives it: one login finds wsp on the box
// and reads the lock the way servingHost does, the service started when
// nothing serves, the box's port forwarded to a free one here with the
// forward's pid recorded, and wsp pair read for its code. A saved host is
// reached by reading the lock again, so a service that came back on another
// port or another address is found there. Every ssh is a fake child here; the
// words, the argv and the pids are what is checked.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noWspLine, sshFailedLine, sshRoad, type ChildLike, type SshRoadDeps } from "../src/ssh-road.js";

const LOCK = { pid: 12, port: 4400, wsPort: 4410, address: "127.0.0.1", startedAt: "2026-09-11T10:00:00.000Z" };
const WSP = "/usr/local/bin/wsp";

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

/** The remote command as the box's shell sees it: the probe travels base64 into sh, so it is decoded to be read. */
const remote = (args: string[]): string => {
  const word = args[args.length - 1]!;
  const packed = /^echo (\S+) \| base64 -d \| sh$/.exec(word);
  return packed === null ? word : Buffer.from(packed[1]!, "base64").toString("utf8");
};
const isForward = (args: string[]): boolean => args.includes("-N");
const isProbe = (args: string[]): boolean => !isForward(args) && remote(args).includes("host.lock");
const probeAnswer = (lock: typeof LOCK | undefined, wsp = WSP): string => `${wsp === "" ? "no-wsp" : `wsp ${wsp}`}\n${lock === undefined ? "none" : `lock ${JSON.stringify(lock)}`}\n`;
const forwardTarget = (args: string[]): string => args[args.indexOf("-L") + 1]!;
const settle = (): Promise<void> => new Promise(r => setImmediate(r));

/** A pid that was real a moment ago and is not alive now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid;
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("sshRoad", () => {
  it("a box without wsp answers the one sentence with the install line, and no ssh is left running", async () => {
    const d = fakeDeps((_args, child) => child.say(probeAnswer(undefined, "")));
    const road = sshRoad(d);
    await expect(road.open({ address: "maya@box", port: 2222 })).rejects.toThrow(noWspLine("maya@box"));
    expect(noWspLine("maya@box")).toBe("wsp is not installed on maya@box: run npm i -g @zingzy/wsp there, then connect again.");
    expect(road.pids()).toEqual([]);
    expect(d.spawned[0]!.slice(0, 7)).toEqual(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p"]);
    expect(d.spawned[0]).toContain("2222");
    expect(d.spawned[0]).toContain("maya@box");
    // The probe is one sh script, whatever shell the login has.
    expect(d.spawned[0]!.at(-1)).toMatch(/^echo \S+ \| base64 -d \| sh$/);
  });

  it("a login shell that prints a banner first still answers the install sentence, and a probe sh or base64 refused is said in the box's words", async () => {
    const banner = fakeDeps((_args, child) => child.say(`Welcome to the box\nno-wsp\n`));
    await expect(sshRoad(banner).open({ address: "maya@box" })).rejects.toThrow(noWspLine("maya@box"));
    // The base64 road fails before the script runs: stdout is empty and stderr holds the one line worth reading.
    const noBase64 = fakeDeps((_args, child) => child.fail("sh: 1: base64: not found\n", 127));
    await expect(sshRoad(noBase64).open({ address: "maya@box" })).rejects.toThrow(sshFailedLine("maya@box", "sh: 1: base64: not found"));
    const refused = fakeDeps((_args, child) => child.fail("sh: 3: Syntax error: word unexpected\n", 2));
    await expect(sshRoad(refused).reach({ address: "maya@box" })).rejects.toThrow(sshFailedLine("maya@box", "sh: 3: Syntax error: word unexpected"));
  });

  it("finds wsp where npm puts it when the login shell's PATH lacks it, and runs the box's commands by that path", async () => {
    const d = fakeDeps((args, child) => {
      if (isForward(args)) return;
      if (isProbe(args)) return child.say(probeAnswer(LOCK, "/home/maya/.npm-global/bin/wsp"));
      if (remote(args) === "/home/maya/.npm-global/bin/wsp pair") return child.say("code        ABCDEFGH\n");
      child.fail(`unexpected: ${remote(args)}`);
    });
    const road = sshRoad(d);
    expect(await road.open({ address: "maya@box" })).toEqual({ url: "http://127.0.0.1:52001", code: "ABCDEFGH" });
    const probe = remote(d.spawned[0]!);
    for (const where of ["command -v wsp", "npm prefix -g", ".npm-global/bin", ".local/bin", ".nvm/versions/node", "/usr/local/bin", "/opt/homebrew/bin"]) expect(probe).toContain(where);
    road.closeAll();
  });

  it("a login ssh refuses is said with ssh's own words", async () => {
    const d = fakeDeps((_args, child) => child.fail("maya@box: Permission denied (publickey).\n"));
    await expect(sshRoad(d).open({ address: "maya@box" })).rejects.toThrow(sshFailedLine("maya@box", "maya@box: Permission denied (publickey)."));
    expect(d.spawned[0]).not.toContain("-p");
  });

  it("with a host serving, forwards its port here, pairs, and records the forward's pid until it is closed", async () => {
    const d = fakeDeps((args, child) => {
      if (isForward(args)) return;
      if (isProbe(args)) return child.say(probeAnswer(LOCK));
      if (remote(args) === `${WSP} pair`) return child.say("code        ABCD-EFGH\nexpires     in 10m\nopen        http://127.0.0.1:4400\n");
      child.fail(`unexpected: ${remote(args)}`);
    });
    const road = sshRoad(d);
    expect(await road.open({ address: "maya@box", port: 2222 })).toEqual({ url: "http://127.0.0.1:52001", code: "ABCD-EFGH" });
    const forward = d.spawned.find(isForward)!;
    expect(forwardTarget(forward)).toBe("127.0.0.1:52001:127.0.0.1:4400");
    expect(road.pids()).toEqual([d.children.find(c => c.exitCode === null)!.pid]);
    // Nothing started a service: the lock named a live host.
    expect(d.spawned.some(a => remote(a).includes("--service"))).toBe(false);
    road.closeAll();
    expect(d.children.filter(c => c.killed)).toHaveLength(1);
    await settle();
    expect(road.pids()).toEqual([]);
  });

  it("with nothing serving, starts wsp as a service on the box's own computer alone, then reads the lock it wrote", async () => {
    let started = false;
    const d = fakeDeps((args, child) => {
      if (isForward(args)) return;
      if (isProbe(args)) return child.say(probeAnswer(started ? LOCK : undefined));
      if (remote(args) === `${WSP} up --service --listen 127.0.0.1 --port 0`) {
        started = true;
        return child.say("app         http://127.0.0.1:4400\n");
      }
      if (remote(args) === `${WSP} pair`) return child.say("code        ABCDEFGH\n");
      child.fail(`unexpected: ${remote(args)}`);
    });
    const road = sshRoad(d);
    expect(await road.open({ address: "maya@box" })).toEqual({ url: "http://127.0.0.1:52001", code: "ABCDEFGH" });
    expect(d.spawned.map(remote).filter(c => c.startsWith(WSP))).toEqual([`${WSP} up --service --listen 127.0.0.1 --port 0`, `${WSP} pair`]);
    road.closeAll();
  });

  it("a service the box refuses to start is said in the box's words", async () => {
    const d = fakeDeps((args, child) => {
      if (isProbe(args)) return child.say(probeAnswer(undefined));
      child.fail("wsp up --service: nothing to serve; run wsp init first\n", 1);
    });
    await expect(sshRoad(d).open({ address: "maya@box" })).rejects.toThrow(/^wsp up --service: nothing to serve; run wsp init first$/);
  });

  it("a forward that dies before the page answers is said with its words", async () => {
    const d = fakeDeps((args, child) => {
      if (isForward(args)) return child.fail("bind [127.0.0.1]:52001: Address already in use\n");
      if (isProbe(args)) return child.say(probeAnswer(LOCK));
    }, { serves: async () => false });
    const road = sshRoad(d);
    await expect(road.open({ address: "maya@box" })).rejects.toThrow(sshFailedLine("maya@box", "bind [127.0.0.1]:52001: Address already in use"));
    expect(road.pids()).toEqual([]);
  });

  it("reaching a saved host reads the lock again: the same host keeps its one forward, and a service that came back on another port or address is forwarded there", async () => {
    let lock = LOCK;
    const d = fakeDeps((args, child) => {
      if (isForward(args)) return;
      if (isProbe(args)) return child.say(probeAnswer(lock));
    }, { freePort: vi.fn(async () => 52009) });
    const road = sshRoad(d);
    expect(await road.reach({ address: "maya@box" }, 52001)).toBe("http://127.0.0.1:52001");
    expect(await road.reach({ address: "maya@box" }, 52001)).toBe("http://127.0.0.1:52001");
    expect(d.spawned.filter(isForward)).toHaveLength(1);
    expect(d.freePort).not.toHaveBeenCalled();
    // The service restarted with --port 0 and the host now binds one named address: the lock says so, the old
    // forward goes, the new one points where the box's own tools would dial, and the local port stays the record's.
    lock = { ...LOCK, port: 4500, address: "172.17.0.2" };
    expect(await road.reach({ address: "maya@box" }, 52001)).toBe("http://127.0.0.1:52001");
    const forwards = d.spawned.filter(isForward);
    expect(forwards).toHaveLength(2);
    expect(forwardTarget(forwards[1]!)).toBe("127.0.0.1:52001:172.17.0.2:4500");
    expect(d.children.filter(c => c.killed)).toHaveLength(1);
    // A wildcard bind is dialled at loopback on the box, the one address that is not itself a place to dial.
    lock = { ...LOCK, port: 4600, address: "0.0.0.0" };
    await road.reach({ address: "maya@box" }, 52001);
    expect(forwardTarget(d.spawned.filter(isForward)[2]!)).toBe("127.0.0.1:52001:127.0.0.1:4600");
    road.closeForward("maya@box");
    expect(await road.reach({ address: "maya@box" })).toBe("http://127.0.0.1:52009");
    road.closeAll();
  });

  it("a box serving a moved home is forwarded and paired for the host that home runs, with the probe run by a real sh", async () => {
    // The box's folders are real here and the probe script is run by sh over them, so what the road forwards to is
    // the home the box's own wsp pair would work on and not a second reading of the pointer.
    const dir = mkdtempSync(join(tmpdir(), "wsp-ssh-box-"));
    dirs.push(dir);
    const bin = join(dir, "bin");
    const user = join(dir, "user");
    const moved = join(dir, "moved");
    for (const d of [bin, join(user, ".wsp"), moved]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, "wsp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(user, ".wsp", "current-home"), `${moved}\n`);
    const wsp = join(bin, "wsp");
    const box = (args: string[], child: FakeChild): void => {
      if (isForward(args)) return;
      const command = remote(args);
      if (isProbe(args)) {
        const ran = spawnSync("/bin/sh", ["-c", command], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: user }, encoding: "utf8" });
        return child.say(ran.stdout, ran.status ?? 0);
      }
      if (command === `${wsp} pair`) return child.say("code        ABCDEFGH\n");
      child.fail(`unexpected: ${command}`);
    };

    // Nothing serves yet, on either home: the pointer alone is no host to reach.
    const cold = fakeDeps(box);
    await expect(sshRoad(cold).reach({ address: "maya@box" })).rejects.toThrow(/no wsp host is serving on maya@box/);

    writeFileSync(join(moved, "host.lock"), JSON.stringify({ pid: process.pid, port: 4400, wsPort: 4410, address: "127.0.0.1", startedAt: "2026-09-11T10:00:00.000Z" }));
    const d = fakeDeps(box);
    const road = sshRoad(d);
    expect(await road.open({ address: "maya@box", port: 2222 })).toEqual({ url: "http://127.0.0.1:52001", code: "ABCDEFGH" });
    expect(forwardTarget(d.spawned.find(isForward)!)).toBe("127.0.0.1:52001:127.0.0.1:4400");
    expect(d.spawned.map(remote).filter(c => c.startsWith(wsp))).toEqual([`${wsp} pair`]);
    road.closeAll();

    // The moved home's host is gone: the pointer goes unfollowed and the box's own home is what answers.
    writeFileSync(join(moved, "host.lock"), JSON.stringify({ pid: deadPid(), port: 4400, wsPort: 4410, startedAt: "2026-09-11T10:00:00.000Z" }));
    writeFileSync(join(user, ".wsp", "host.lock"), JSON.stringify({ pid: process.pid, port: 4700, wsPort: 4710, startedAt: "2026-09-11T10:00:00.000Z" }));
    const after = fakeDeps(box);
    const second = sshRoad(after);
    expect(await second.reach({ address: "maya@box" })).toBe("http://127.0.0.1:52001");
    expect(forwardTarget(after.spawned.find(isForward)!)).toBe("127.0.0.1:52001:127.0.0.1:4700");
    second.closeAll();
  });

  it("reaching a saved host on a box where nothing serves any more says so, and starts nothing", async () => {
    const d = fakeDeps((args, child) => {
      if (isProbe(args)) return child.say(probeAnswer(undefined));
      child.fail(`unexpected: ${remote(args)}`);
    });
    await expect(sshRoad(d).reach({ address: "maya@box" })).rejects.toThrow(/no wsp host is serving on maya@box/);
    expect(d.spawned.some(a => remote(a).includes("--service"))).toBe(false);
  });

  it("closing everything at quit kills a remote command still running, not only the forwards", async () => {
    const d = fakeDeps(() => {});
    const road = sshRoad(d);
    const hanging = road.reach({ address: "maya@box" });
    hanging.catch(() => {});
    await settle();
    expect(road.pids()).toHaveLength(1);
    road.closeAll();
    await settle();
    expect(d.children[0]!.killed).toBe(true);
    expect(road.pids()).toEqual([]);
  });
});
