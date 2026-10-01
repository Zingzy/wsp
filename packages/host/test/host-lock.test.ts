// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { bootLineOf } from "@wsp/protocol";
import { createRuntime, memoryStore, tokenDigest, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, hostRoadWord, hostStoppedLine, serve, type CliIO } from "../src/cli.js";
import { hostTokenFor, ownPid, pidAlive } from "../src/host-lock.js";
import { dialHost } from "../src/verbs.js";
import type { HostHandle } from "../src/server.js";
import { stubBackend } from "./stub-backend.js";
import { describeWithDists } from "./built-bin.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { CLOUD_ON } from "../src/cloud.js";

runsFromItsOwnFolder();

const PAGE = `<!doctype html>
<html><head><script type="module" crossorigin src="/assets/app.js"></script></head>
<body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { token: "" };</script>
</body></html>
`;

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const quietIO: CliIO = { log: () => {}, error: () => {}, ask: noPrompt, askSecret: noPrompt };

function testRuntime(): Runtime {
  return createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
}

interface Lock {
  pid: number;
  port: number;
  startedAt: string;
  startedBy?: "verb";
}

function readLock(path: string): Lock {
  return JSON.parse(readFileSync(path, "utf8")) as Lock;
}

/** A pid that was real a moment ago and is not alive now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid;
}

describe("serve takes host.lock next to the state file", () => {
  let dir: string;
  let home: string;
  let webDir: string;
  let statePath: string;
  let lockPath: string;
  const handles: HostHandle[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-lock-home-"));
    home = join(dir, "custom");
    webDir = join(home, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(home, "state", "state.json");
    lockPath = join(home, "state", "host.lock");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_lock_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", home);
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(dir: string = webDir): Promise<HostHandle> {
    const h = await serve(quietIO, { port: 0, statePath, webDir: dir, runtime: testRuntime() });
    handles.push(h);
    return h;
  }

  it("the token file beside the state opens the page as soon as the page answers, before the host has swept its provider", async () => {
    // A host bound its page, then listed its provider's machines before it wrote the token file, and a client that
    // read the page in that gap found no token to hold it to: the app's first launch after installing the service
    // waited out a slow listing and gave up.
    const port = await new Promise<number>(resolve => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        probe.close(() => resolve(typeof addr === "object" && addr !== null ? addr.port : 0));
      });
    });
    const rt = testRuntime();
    let release = (): void => {};
    const held = new Promise<void>(resolve => (release = resolve));
    const reap = rt.reap.bind(rt);
    Object.assign(rt, { reap: async (...args: Parameters<Runtime["reap"]>) => (await held, reap(...args)) });
    const serving = serve(quietIO, { port, statePath, webDir, runtime: rt });
    try {
      const boot = await vi.waitFor(
        async () => {
          const line = bootLineOf(await (await fetch(`http://127.0.0.1:${port}/`)).text());
          expect(line?.tokenHash).toBeDefined();
          return line!;
        },
        { timeout: 5_000, interval: 50 },
      );
      const token = hostTokenFor(statePath);
      expect(token, "no token file while the host sweeps").toBeDefined();
      expect(tokenDigest(token!)).toBe(boot.tokenHash);
    } finally {
      release();
      handles.push(await serving);
    }
  });

  it("the token beside the lock is the new host's from the moment the lock stands, so no line dials it with the old one", async () => {
    // A host took its lock, then read its places before it wrote its token, and a line that read the lock in that
    // gap dialled the new host with the token the host before it had left, which it refused as unauthorized.
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "host-token"), "the-host-before\n");
    const rt = testRuntime();
    let release = (): void => {};
    const held = new Promise<void>(resolve => (release = resolve));
    let asked = false;
    Object.assign(rt, { places: { list: async () => ((asked = true), await held, []) } });
    const serving = serve(quietIO, { port: 0, statePath, webDir, runtime: rt });
    try {
      await vi.waitFor(() => expect(asked).toBe(true));
      expect(readLock(lockPath).pid).toBe(process.pid);
      expect(hostTokenFor(statePath)).not.toBe("the-host-before");
    } finally {
      release();
      handles.push(await serving);
    }
  });

  it("a line that reads a new host's lock before its token waits for that token rather than dialling with the last one", async () => {
    // The gap a second process can land in: the lock names the new host, which already answers, while the file
    // beside it still holds the token the host before it wrote. Made here by putting that token back by hand.
    await start();
    const tokenPath = join(home, "state", "host-token");
    const theirs = readFileSync(tokenPath, "utf8");
    writeFileSync(tokenPath, "the-host-before\n");
    const dialled = dialHost(statePath);
    setTimeout(() => writeFileSync(tokenPath, theirs), 300);
    const client = await dialled;
    try {
      await client.request("sessions.list");
    } finally {
      client.close();
    }
  });

  it("writes pid, port and start time, and removes the lock on close", async () => {
    const before = Date.now();
    const h = await start();
    const lock = readLock(lockPath);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(h.port);
    expect(Date.parse(lock.startedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(lock.startedAt)).toBeLessThanOrEqual(Date.now());

    await h.close();
    handles.splice(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("the state folder is the owner's when the host takes its lock, and one an older build left wider is repaired", async () => {
    mkdirSync(join(home, "state"), { recursive: true });
    chmodSync(join(home, "state"), 0o755);
    const h = await start();
    expect(statSync(join(home, "state")).mode & 0o777).toBe(0o700);
    expect(existsSync(lockPath)).toBe(true);
    await h.close();
    handles.splice(0);
  });

  it("refuses a second host on the same state file, naming the running pid and port", async () => {
    const first = await start();
    await expect(start()).rejects.toThrow(
      new RegExp(`pid ${process.pid}\\b.*\\b${first.port}\\b`),
    );
    // The loser must not take the winner's lock with it.
    expect(readLock(lockPath).port).toBe(first.port);
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200);
  });

  it("names wsp down when the lock a second host meets was written by a host a verb started", async () => {
    const first = await start();
    writeFileSync(lockPath, JSON.stringify({ ...readLock(lockPath), startedBy: "verb" }));
    await expect(start()).rejects.toThrow("wsp down stops it, or point --state at a different file.");
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200);
  });

  it("names wsp down for the service's own host too, since wsp down is what stops that one", async () => {
    const first = await start();
    writeFileSync(lockPath, JSON.stringify({ ...readLock(lockPath), startedBy: "service" }));
    await expect(start()).rejects.toThrow("wsp down stops it, or point --state at a different file.");
    expect(hostRoadWord("service")).toBe("the service");
    expect(hostStoppedLine("service", 42, lockPath)).toBe(`stopped the host the service started (pid 42); nothing serves ${lockPath} now`);
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200);
  });

  it("removes a lock whose pid is no longer alive and starts", async () => {
    mkdirSync(join(home, "state"));
    const stale = { pid: deadPid(), port: 1, startedAt: "2026-09-01T00:00:00.000Z" };
    writeFileSync(lockPath, JSON.stringify(stale));

    const h = await start();
    const lock = readLock(lockPath);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(h.port);
  });

  it("writes nothing under the person's own wsp home while it serves a home somebody named", async () => {
    // A host on another state file writing a file under ~/.wsp is two hosts sharing one file; the one way a line
    // reaches this host is naming its home, which the person does with --state or WSP_HOME.
    const h = await start();
    expect(existsSync(join(dir, "user", ".wsp"))).toBe(false);

    await h.close();
    handles.splice(0);
    expect(existsSync(join(dir, "user", ".wsp"))).toBe(false);
  });

  it("wsp init refuses when the host holding the lock cannot take the build, naming wsp down before any pid, and boots nothing", async () => {
    // A lock a live process holds whose host answers nowhere: the build cannot go through its door, so the run says
    // how to take that host down. A host that does answer takes the build instead; that road is init-beside's test.
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port: 1, address: "127.0.0.1", startedAt: new Date().toISOString() }));
    writeFileSync(join(home, "state", "host-token"), "tok");
    // A host somewhere else is where every other verb would go; the build belongs to the process holding this lock.
    vi.stubEnv("WSP_HOST", "elsewhere");
    const errors: string[] = [];
    const code = await cli(["init", "--state", statePath], { ...quietIO, error: line => errors.push(line) });
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`wsp init: the wsp host serving ${statePath} (pid ${process.pid}) cannot take this build`);
    expect(errors[0]).toContain(`Take it down first (wsp down for a service, Ctrl-C in its terminal or kill ${process.pid} for one started by hand)`);
    expect(errors[0]).not.toContain("elsewhere");
    expect(readLock(lockPath).pid).toBe(process.pid);
  });

  it.runIf(CLOUD_ON)("wsp init --provider beside a serving host is refused, naming the provider that host forks on and the wsp up that moves it", async () => {
    // The host serving this state file is the process that runs the build, on the provider it started on: a
    // provider named on this line reaches no runtime of this run's, so it is said out loud rather than dropped.
    vi.stubEnv("WSP_PROVIDER", "solari");
    const first = await start();
    const errors: string[] = [];
    const code = await cli(["init", "--provider", "box", "--state", statePath], { ...quietIO, error: line => errors.push(line) });
    expect(code).toBe(3);
    // The wsp up the sentence hands over is this run's own line, so it names the state file this home keeps its
    // host under: without the --state it would start a host on this computer's default state file instead.
    expect(errors).toEqual([
      `wsp init: the wsp host serving ${statePath} (pid ${process.pid}) runs this build and forks on solari, not box. Drop --provider, or take that host down and start it again with wsp up --state '${statePath}' --provider 'box'.`,
    ]);
    // Refused before the run opens: the host is still serving and nothing of the build was read or booted.
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200);
  });

  it("does not leave a lock behind when the host fails to start", async () => {
    const broken = join(home, "broken-web");
    mkdirSync(broken);
    await expect(start(broken)).rejects.toThrow(/web app not built/);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describeWithDists("hosts starting at once against a stale lock", ["protocol", "own-file"], () => {
  // Six takers, each its own process as a host is, kept alive across every round so the moment they all start from
  // is not spread out by each one's boot. A round is a stale lock and a shared moment in the round file; one that
  // wins writes its token next, as serve does, and stays alive so the others meet a live lock.
  const TAKER = `
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { takeLock } from ${JSON.stringify(fileURLToPath(new URL("../src/host-lock.ts", import.meta.url)))};
    const [dir] = process.argv.slice(2);
    const nap = new Int32Array(new SharedArrayBuffer(4));
    const parent = process.ppid;
    for (let seen = -1; process.ppid === parent; ) {
      let round;
      try {
        round = JSON.parse(readFileSync(join(dir, "round"), "utf8"));
      } catch {
        round = { r: seen };
      }
      if (round.r === "done") break;
      if (round.r === seen) {
        Atomics.wait(nap, 0, 0, 2);
        continue;
      }
      seen = round.r;
      // Starts at once are not in step: each is up to a fifth of a millisecond behind the shared moment.
      const at = round.at + Math.random() * 0.2;
      while (performance.timeOrigin + performance.now() < at) {}
      let said;
      try {
        takeLock(join(dir, "host.lock"), join(dir, "state.json"), { port: 1 });
        writeFileSync(join(dir, "host-token"), String(process.pid));
        said = "won";
      } catch (e) {
        said = "refused " + e.message;
      }
      process.stdout.write(JSON.stringify({ r: seen, pid: process.pid, said }) + "\\n");
    }
  `;
  const TAKERS = 6;
  const ROUNDS = 30;

  /** One busy loop per core for as long as the case runs, so the takers are preempted mid-take as a loaded Mac does.
   * Each is a process group of its own, killed however the case ends, and one whose worker was killed outright ends
   * itself once it finds its parent gone. */
  const BUSY = "const parent = process.ppid; for (let i = 0; ; i++) if (i % 1e8 === 0 && process.ppid !== parent) process.exit();";
  const loadEveryCore = (): { stop(): void } => {
    const loops = Array.from({ length: availableParallelism() }, () => spawn(process.execPath, ["-e", BUSY], { stdio: "ignore", detached: true }));
    const stop = (): void => {
      process.off("exit", stop);
      for (const loop of loops) {
        try {
          process.kill(-loop.pid!, "SIGKILL");
        } catch {
          // Gone already.
        }
      }
    };
    process.on("exit", stop);
    return { stop };
  };

  it("exactly one of six takes it in every round on a loaded computer, the lock names that one, and the token is that one's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-lock-race-"));
    const load = loadEveryCore();
    const heard = new Map<number, { pid: number; said: string }[]>();
    const takers: ChildProcess[] = [];
    const setRound = (round: { r: number | "done"; at?: number }): void => {
      writeFileSync(join(dir, "round.next"), JSON.stringify(round));
      renameSync(join(dir, "round.next"), join(dir, "round"));
    };
    try {
      writeFileSync(join(dir, "taker.mts"), TAKER);
      for (let i = 0; i < TAKERS; i++) {
        const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, "taker.mts"), dir], { stdio: ["ignore", "pipe", "inherit"] });
        let rest = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          const lines = (rest + chunk.toString()).split("\n");
          rest = lines.pop()!;
          for (const line of lines) {
            const { r, pid, said } = JSON.parse(line) as { r: number; pid: number; said: string };
            heard.set(r, [...(heard.get(r) ?? []), { pid, said }]);
          }
        });
        takers.push(child);
      }
      for (let r = 0; r < ROUNDS; r++) {
        writeFileSync(join(dir, "host.lock"), JSON.stringify({ pid: deadPid(), port: 1, startedAt: "2026-01-01T00:00:00.000Z" }));
        rmSync(join(dir, "host-token"), { force: true });
        // The first round waits for six processes to boot on a loaded computer; the rest only for the file to be read.
        setRound({ r, at: Date.now() + (r === 0 ? 5_000 : 300) });
        const said = await vi.waitFor(
          () => {
            const got = heard.get(r) ?? [];
            expect(got).toHaveLength(TAKERS);
            return got;
          },
          { timeout: 20_000, interval: 20 },
        );
        const lines = said.map(s => `${s.pid} ${s.said}`).join("\n");
        expect(said.filter(s => s.said !== "won" && !s.said.startsWith("refused ")), lines).toEqual([]);
        const won = said.filter(s => s.said === "won");
        expect(won, `round ${r}:\n${lines}`).toHaveLength(1);
        expect(readLock(join(dir, "host.lock")).pid, lines).toBe(won[0]!.pid);
        expect(readFileSync(join(dir, "host-token"), "utf8"), lines).toBe(String(won[0]!.pid));
      }
      setRound({ r: "done" });
    } finally {
      load.stop();
      for (const child of takers) child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("what the lock's pid says", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-lock-reads-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** A pid that was real a moment ago and is not alive now. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", "0"]);
    expect(child.status).toBe(0);
    return child.pid;
  }

  it("reads a pid of this login as its own, and a pid that is gone as neither own nor alive", () => {
    expect(ownPid(process.pid)).toBe(true);
    expect(pidAlive(process.pid)).toBe(true);
    const gone = deadPid();
    expect(ownPid(gone)).toBe(false);
    expect(pidAlive(gone)).toBe(false);
  });

  it.runIf(process.getuid !== undefined && process.getuid() !== 0)("reads a live process of another login as not this login's, while it is still a held lock", () => {
    // Process 1 belongs to root and answers EPERM to a signal from anyone else, which is the one reading here.
    expect(ownPid(1)).toBe(false);
    expect(pidAlive(1)).toBe(true);
  });
});
