// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVICE_MANAGERS, dialHost, httpProbe, localWiring, localWorkFolder, makeRuntime, noManagerLine, serve, serviceAddressHere, serviceTag, severalAccountHostsLine, startHost, writeHost, type CliIO, type HostHandle, type HostRecord, type ServiceDeps, type ServiceRunner } from "@wsp/host";
import { hostNoKeyLine } from "@wsp/protocol";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { copyingFake, fakeDaemonStart } from "../../../packages/host/test/verbs-fixture.js";
import { ensureService, firstLaunch, homeOf, hostTokenMatches, loginStart, openHost, openHostReady, runningHere, setLoginStart, statePathIn, stopWsp, userDataIn, workingHere, type HostSession, type OpenHostOptions, type ServiceRoad } from "../src/host-lifecycle.js";

const PAGE = `<!doctype html>
<html><head><title>wsp</title></head>
<body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { token: "" };</script>
</body></html>
`;

function fakeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-desktop-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), PAGE);
  return dir;
}

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
function quietIO(lines: string[] = []): CliIO {
  return { log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt };
}

function testRuntime(): Runtime {
  return createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
}

function listen(server: Server | TcpServer): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

function closeServer(server: Server | TcpServer): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function bootOf(url: string): Promise<{ tokenHash?: string; token?: string } | undefined> {
  const html = await (await fetch(url)).text();
  const m = html.match(/window\.__WSP__ = (\{[^<]*\});<\/script>/);
  return m ? (JSON.parse(m[1]!) as { tokenHash?: string; token?: string }) : undefined;
}

const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A host's page as another process on this computer sees it pass by: every request the window sent, with the
 * headers it carried, forwarded to the real host and answered as it answered. */
async function recording(upstream: number): Promise<{ port: number; requests: { url: string; authorization?: string }[]; close(): Promise<void> }> {
  const requests: { url: string; authorization?: string }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    requests.push({ url: req.url ?? "", ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}) });
    void fetch(`http://127.0.0.1:${upstream}${req.url ?? "/"}`).then(async from => {
      res.writeHead(from.status, { "content-type": from.headers.get("content-type") ?? "text/plain" });
      res.end(Buffer.from(await from.arrayBuffer()));
    });
  });
  const port = await listen(server);
  return { port, requests, close: () => closeServer(server) };
}

/** A pid that was real a moment ago and is not alive now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid;
}

/** Whether this machine has an IPv6 loopback to bind at all: a runner without one cannot hold the ::1 case. */
const ipv6Loopback = await new Promise<boolean>(resolve => {
  const probe = createTcpServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

/** A lock and a token file as a host serving this state file leaves them beside it. */
/** A host after the one serving: a live process of its own takes the lock `afterMs` from now and binds its page
 * 600 ms after that, as a host does that reads its computers between the two. */
async function handedOn(statePath: string, afterMs: number): Promise<{ port: number; done(): Promise<void> }> {
  const probe = createTcpServer();
  const port = await listen(probe);
  await closeServer(probe);
  const other = spawn("sleep", ["30"], { stdio: "ignore" });
  let host: Promise<HostHandle> | undefined;
  let timer = setTimeout(() => {
    writeFileSync(join(statePath, "..", "host.lock"), JSON.stringify({ pid: other.pid, port, startedAt: new Date().toISOString(), startedBy: "service" }));
    timer = setTimeout(() => {
      host = startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port }).then(h => (serving(statePath, h, { pid: other.pid, startedBy: "service" }), h));
    }, 600);
  }, afterMs);
  return { port, done: async () => (clearTimeout(timer), other.kill(), await (await host)?.close()) };
}

function serving(statePath: string, h: HostHandle, over: Record<string, unknown> = {}): void {
  writeFileSync(join(statePath, "..", "host.lock"), JSON.stringify({ pid: process.pid, port: h.port, startedAt: new Date().toISOString(), ...over }));
  writeFileSync(join(statePath, "..", "host-token"), `${h.authToken}\n`);
}

/** launchd as far as this window reads it: the real manager's unit files and lines, answered by a fake that serves
 * a real host once a unit is loaded, as the shim's `wsp up` would, and takes it away at a bootout. */
function fakeLaunchd(statePath: string, runtime: () => Runtime = testRuntime): { road: ServiceRoad & ServiceDeps; ran: string[][]; loaded: () => boolean; host: () => HostHandle | undefined; load: () => Promise<void>; atLogin: () => boolean; setAtLogin: (on: boolean) => void } {
  const ran: string[][] = [];
  let loaded = false;
  let host: HostHandle | undefined;
  const load = async (): Promise<void> => {
    loaded = true;
    host = await startHost({ runtime: runtime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, host, { startedBy: "service" });
  };
  let atLogin = true;
  const run: ServiceRunner = async argv => {
    ran.push([...argv]);
    const verb = argv[1];
    if (verb === "print") return loaded ? { code: 0, output: "state = running" } : { code: 113, output: "Could not find service" };
    if (verb === "enable" || verb === "disable") {
      atLogin = verb === "enable";
      return { code: 0, output: "" };
    }
    if (verb === "print-disabled") return { code: 0, output: `disabled services = {\n\t\t"${argv[2]!.replace("gui/", "x")}" => enabled\n${atLogin ? "" : `\t\t"${SERVICE_MANAGERS.launchd.unit(serviceAddressHere(statePath)).name}" => disabled\n`}}` };
    if (verb === "bootstrap") {
      // launchd refuses to load a label switched off at login until it is switched on again.
      if (!atLogin) return { code: 5, output: "Bootstrap failed: 5: Input/output error" };
      await load();
      return { code: 0, output: "" };
    }
    if (verb === "bootout") {
      loaded = false;
      await host?.close();
      host = undefined;
      rmSync(join(statePath, "..", "host.lock"), { force: true });
      return { code: 0, output: "" };
    }
    return { code: 1, output: `unexpected ${argv.join(" ")}` };
  };
  const road = {
    platform: "darwin",
    manager: SERVICE_MANAGERS.launchd,
    run,
    waitMs: 10_000,
    answers: httpProbe,
    keys: { env: {}, cwd: tmpdir() },
    dial: dialHost,
    stop: () => {},
    here: async () => undefined,
  };
  return { road, ran, loaded: () => loaded, host: () => host, load, atLogin: () => atLogin, setAtLogin: on => void (atLogin = on) };
}

describe("openHost", () => {
  let home: string;
  let statePath: string;
  let shim: string;
  let existing: HostHandle | undefined;
  let launchd: ReturnType<typeof fakeLaunchd>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-desktop-home-"));
    statePath = join(home, "state.json");
    shim = join(home, "bin", "wsp");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_desktop_key");
    vi.stubEnv("HOME", home);
    vi.stubEnv("WSP_HOME", home);
    launchd = fakeLaunchd(statePath);
  });
  afterEach(async () => {
    await launchd.host()?.close();
    await existing?.close();
    existing = undefined;
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const unitPath = (): string => SERVICE_MANAGERS.launchd.unit(serviceAddressHere(statePath)).path;

  function open(over: Partial<OpenHostOptions> = {}, lines: string[] = []): Promise<HostSession> {
    return openHost({ statePath, home, shim, io: quietIO(lines), service: launchd.road, ...over });
  }

  it("installs the unit running the shim with the service mark when none is registered, loads it, waits for the lock, attaches", async () => {
    const session = await open();
    expect(launchd.ran.map(argv => argv.slice(0, 2).join(" "))).toEqual(["launchctl enable", "launchctl bootstrap"]);
    const unit = readFileSync(unitPath(), "utf8");
    expect(unitPath()).toBe(join(home, "Library", "LaunchAgents", `com.wsp.host.${serviceTag(statePath)}.plist`));
    const words = [...unit.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]);
    expect(words.slice(1, 5)).toEqual([shim, "up", "--state", statePath]);
    expect(unit).toContain("<key>WSP_STARTED_BY</key><string>service</string>");
    expect(unit).toContain(`<key>HOME</key><string>${home}</string>`);
    expect(unit).toContain(`<key>WSP_HOME</key><string>${home}</string>`);
    expect(unit).toContain(`<key>WorkingDirectory</key><string>${home}</string>`);
    expect(unit).toContain(`<key>StandardOutPath</key><string>${join(home, "host.log")}</string>`);
    expect(session).toMatchObject({ url: `http://127.0.0.1:${launchd.host()!.port}`, remote: false });
    expect((await bootOf(session.url))?.tokenHash).toBe(digestOf(launchd.host()!.authToken));
  });

  it("a unit naming another shim is rewritten: the unit is stopped, written over, and loaded again", async () => {
    const other = { ...serviceAddressHere(statePath), argv: ["/Applications/Old.app/wsp", "up"], cwd: home, env: {}, logPath: join(home, "host.log") };
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(unitPath(), SERVICE_MANAGERS.launchd.text(other));
    // Loaded, and serving nothing: the old shim names an app that is gone, and launchd keeps starting it.
    const run = launchd.road.run;
    let first = true;
    launchd.road.run = async (argv, waitMs) => {
      if (first && argv[1] === "print") {
        first = false;
        return { code: 0, output: "state = spawn scheduled" };
      }
      return run(argv, waitMs);
    };
    await open();
    expect(launchd.ran.map(argv => argv[1])).toEqual(["print-disabled", "bootout", "enable", "bootstrap"]);
    expect(readFileSync(unitPath(), "utf8")).toContain(`<string>${shim}</string>`);
    expect(readFileSync(unitPath(), "utf8")).not.toContain("Old.app");
  });

  it("a unit wsp up --service wrote behind this shim, with words of its own, is loaded as it stands, not rewritten", async () => {
    const mine = { ...serviceAddressHere(statePath), argv: [shim, "up", "--state", statePath, "--port", "4400", "--listen", "0.0.0.0"], cwd: join(home, "elsewhere"), env: { PATH: "/usr/bin" }, logPath: join(home, "host.log") };
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(unitPath(), SERVICE_MANAGERS.launchd.text(mine));
    const before = readFileSync(unitPath(), "utf8");
    await open();
    expect(launchd.ran.map(argv => argv[1])).toEqual(["print-disabled", "print", "enable", "bootstrap"]);
    expect(readFileSync(unitPath(), "utf8")).toBe(before);
  });

  it("a load launchd refuses because another launch loaded the unit a moment before waits for that one", async () => {
    // Two launches while nothing serves both reach the load; launchd takes the first and refuses the second, which
    // is the same service coming up, not a start that failed.
    const run = launchd.road.run;
    launchd.road.run = async (argv, waitMs) => {
      if (argv[1] !== "bootstrap") return run(argv, waitMs);
      await launchd.load();
      return { code: 5, output: "Bootstrap failed: 5: Input/output error" };
    };
    const session = await open();
    expect(session.url).toBe(`http://127.0.0.1:${launchd.host()!.port}`);
    expect(readFileSync(unitPath(), "utf8")).toContain(`<string>${shim}</string>`);
  });

  it("says in the app's log when a provider key is only in the shell that launched it, which the service starts without", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x-fake");
    const lines: string[] = [];
    await open({}, lines);
    expect(lines.join("\n")).toContain("ANTHROPIC_API_KEY is only in this shell's environment");
    await launchd.road.run(["launchctl", "bootout", "x"]);
    lines.length = 0;
    writeFileSync(join(home, ".env"), "ANTHROPIC_API_KEY=sk-ant-x-fake\n");
    await open({}, lines);
    expect(lines.join("\n")).not.toContain("only in this shell");
  });

  it("a unit written as this launch would write it and let go by launchd is loaded, not rewritten", async () => {
    await open();
    await launchd.road.run(["launchctl", "bootout", "x"]);
    const before = readFileSync(unitPath(), "utf8");
    launchd.ran.length = 0;
    await open();
    expect(launchd.ran.map(argv => argv[1])).toEqual(["print-disabled", "print", "enable", "bootstrap"]);
    expect(readFileSync(unitPath(), "utf8")).toBe(before);
  });

  it("a unit the person set not to start at login is loaded all the same and set back off once it is up", async () => {
    await open();
    await launchd.road.run(["launchctl", "bootout", "x"]);
    launchd.setAtLogin(false);
    launchd.ran.length = 0;
    await open();
    expect(launchd.ran.map(argv => argv[1])).toEqual(["print-disabled", "print", "enable", "bootstrap", "disable"]);
    expect([launchd.loaded(), launchd.atLogin()]).toEqual([true, false]);
  });

  it("reads and sets whether the service starts at login, leaving wsp running, and reads nothing where no service is registered", async () => {
    expect(await loginStart(statePath, launchd.road)).toBeNull();
    await open();
    expect(await loginStart(statePath, launchd.road)).toBe(true);
    expect(await setLoginStart(statePath, false, launchd.road)).toBe(false);
    expect([launchd.loaded(), launchd.atLogin()]).toEqual([true, false]);
    expect(await setLoginStart(statePath, true, launchd.road)).toBe(true);
    await expect(setLoginStart(statePath, false, { ...launchd.road, run: async () => ({ code: 1, output: "Bad request." }) })).rejects.toThrow(/launchctl disable .* exited 1 and said: Bad request\./);
  });

  it("waits past a page that answers before the host has written its token, which a start still in flight serves", async () => {
    // The host binds its page, then sweeps and lists before it writes the token file beside the state: a window
    // that read the page in that gap and compared digests would refuse its own host.
    const run = launchd.road.run;
    launchd.road.run = async (argv, waitMs) => {
      if (argv[1] !== "bootstrap") return run(argv, waitMs);
      const answered = await run(argv, waitMs);
      rmSync(join(home, "host-token"));
      setTimeout(() => writeFileSync(join(home, "host-token"), `${launchd.host()!.authToken}\n`), 400);
      return answered;
    };
    const session = await open();
    expect(session.url).toBe(`http://127.0.0.1:${launchd.host()!.port}`);
  });

  it("the launch that installs the service attaches while the host it started is still listing its provider's machines", async () => {
    // What the first launch after the install meets on a computer with a provider key: the host binds its page, then
    // sweeps and lists at the provider before it is done starting. The launch waited on the token file that came
    // after the listing, gave up, and quit; the next launch found the host ready.
    const probe = createTcpServer();
    const port = await listen(probe);
    await closeServer(probe);
    const rt = testRuntime();
    let release = (): void => {};
    const held = new Promise<void>(resolve => (release = resolve));
    const reap = rt.reap.bind(rt);
    Object.assign(rt, { reap: async (...args: Parameters<Runtime["reap"]>) => (await held, reap(...args)) });
    let serving: Promise<HostHandle> | undefined;
    let loaded = false;
    const road = {
      ...launchd.road,
      waitMs: 3_000,
      run: async (argv: readonly string[]) => {
        if (argv[1] === "print") return loaded ? { code: 0, output: "" } : { code: 113, output: "Could not find service" };
        if (argv[1] === "bootstrap") {
          loaded = true;
          serving = serve(quietIO(), { port, statePath, webDir: fakeWebDir(), runtime: rt });
        }
        return { code: 0, output: "" };
      },
    };
    try {
      const session = await open({ service: road });
      expect(session.url).toBe(`http://127.0.0.1:${port}`);
    } finally {
      release();
      existing = await serving;
    }
  });

  it("a launch that meets the host on its way down, lock and page still up, ends on the host the manager starts next", async () => {
    // What launchctl kickstart -k looks like from the launch: the host that is stopping still holds its lock and
    // serves its page for a moment, so the launch attaches to it, and the next read finds it gone.
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, existing, { startedBy: "service" });
    const going = existing;
    let dials = 0;
    const dial: typeof dialHost = async (path, o) => {
      if (dials++ === 0) {
        await going.close();
        existing = undefined;
        rmSync(join(home, "host.lock"), { force: true });
      }
      return dialHost(path, o);
    };
    const ready = await openHostReady({ statePath, home, shim, io: quietIO(), service: launchd.road }, dial);
    expect(ready.session.url).toBe(`http://127.0.0.1:${launchd.host()!.port}`);
    // Read off the host it ended on, which holds nothing, as the fake manager's host does.
    expect(ready.first).toBe(true);
    expect(launchd.ran.map(argv => argv[1])).toEqual(["enable", "bootstrap"]);
  });

  it("a launch that meets the host a moment later, its page gone and its process still holding the lock, waits for that process and ends on the next host", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, existing, { startedBy: "service" });
    await existing.close();
    existing = undefined;
    // The lock still names a live process, whose page no longer answers: the refusal a squatter gets, which here is
    // a host on its way out that has not yet let go.
    setTimeout(() => rmSync(join(home, "host.lock"), { force: true }), 300);
    const ready = await openHostReady({ statePath, home, shim, io: quietIO(), service: launchd.road });
    expect(ready.session.url).toBe(`http://127.0.0.1:${launchd.host()!.port}`);
  });

  it("a lock whose page answers as something else is refused at once, as a squatter always was", async () => {
    const squatter = createServer((_req, res) => res.end("<html>hello</html>"));
    const port = await listen(squatter);
    try {
      writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
      const t0 = Date.now();
      await expect(openHostReady({ statePath, home, shim, io: quietIO(), service: { ...launchd.road, waitMs: 2_000 } })).rejects.toThrow(/but no wsp host answers there/);
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(launchd.ran).toEqual([]);
    } finally {
      await closeServer(squatter);
    }
  });

  it("a lock whose page answers with another token's digest is refused at once", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, existing);
    writeFileSync(join(home, "host-token"), "a-token-of-some-other-host\n");
    const t0 = Date.now();
    await expect(openHostReady({ statePath, home, shim, io: quietIO(), service: { ...launchd.road, waitMs: 2_000 } })).rejects.toThrow(/another token's digest/);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("a lock of another login, its page answering, is refused at once", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, existing, { pid: 1 });
    const t0 = Date.now();
    await expect(openHostReady({ statePath, home, shim, io: quietIO(), service: { ...launchd.road, waitMs: 2_000 } })).rejects.toThrow(/not this login's/);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("a host that has taken the lock and not yet bound its page is waited for, and the launch attaches once it answers", async () => {
    // Between taking its lock and binding, a host reads its computers, which waits on every box that does not
    // answer: 30 s on the dev home with four unreachable boxes. Its pid stays the same the whole time.
    const probe = createTcpServer();
    const port = await listen(probe);
    await closeServer(probe);
    const at = statePath;
    writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString(), startedBy: "service" }));
    setTimeout(() => {
      void startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port }).then(h => {
        existing = h;
        serving(at, h, { startedBy: "service" });
      });
    }, 600);
    const ready = await openHostReady({ statePath, home, shim, io: quietIO(), service: { ...launchd.road, waitMs: 2_000 } });
    expect(ready.session.url).toBe(`http://127.0.0.1:${port}`);
    expect(launchd.ran).toEqual([]);
  });

  it("the service's new host is waited for past the start's own wait while it holds the lock and binds late, as a host reading unreachable boxes does", async () => {
    // Nothing served, the unit loaded, and the host the manager started took its lock at once but answered on its
    // port only after the start's own wait had run out.
    const probe = createTcpServer();
    const port = await listen(probe);
    await closeServer(probe);
    const at = statePath;
    let loaded = false;
    const road = {
      ...launchd.road,
      waitMs: 400,
      run: async (argv: readonly string[]) => {
        if (argv[1] === "print") return loaded ? { code: 0, output: "" } : { code: 113, output: "Could not find service" };
        if (argv[1] === "bootstrap") {
          loaded = true;
          writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString(), startedBy: "service" }));
          setTimeout(() => {
            void startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port }).then(h => {
              existing = h;
              serving(at, h, { startedBy: "service" });
            });
          }, 1_000);
        }
        return { code: 0, output: "" };
      },
    };
    const ready = await openHostReady({ statePath, home, shim, io: quietIO(), service: road });
    expect(ready.session.url).toBe(`http://127.0.0.1:${port}`);
  });

  it("a host that holds the lock and never answers is given up on, once the longer wait for a starting host has run out, and says how long it waited", async () => {
    const probe = createTcpServer();
    const port = await listen(probe);
    await closeServer(probe);
    writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString(), startedBy: "service" }));
    const t0 = Date.now();
    await expect(openHostReady({ statePath, home, shim, io: quietIO(), service: { ...launchd.road, waitMs: 200 } })).rejects.toThrow(/^after 1\.\ds of waiting, a host .* but no wsp host answers there/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("the service's host that takes the lock and never answers is waited on once, and the line names the whole wait", async () => {
    const probe = createTcpServer();
    const port = await listen(probe);
    await closeServer(probe);
    let loaded = false;
    const road = {
      ...launchd.road,
      waitMs: 200,
      run: async (argv: readonly string[]) => {
        if (argv[1] === "print") return loaded ? { code: 0, output: "" } : { code: 113, output: "Could not find service" };
        if (argv[1] === "bootstrap") {
          loaded = true;
          writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString(), startedBy: "service" }));
        }
        return { code: 0, output: "" };
      },
    };
    const t0 = Date.now();
    await expect(openHostReady({ statePath, home, shim, io: quietIO(), service: road })).rejects.toThrow(/did not start within 1\.\ds/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("a launch that meets the lock passing straight to a new host, which binds a while after taking it, ends on that host", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, existing, { startedBy: "service" });
    await existing.close();
    existing = undefined;
    const next = await handedOn(statePath, 300);
    try {
      const ready = await openHostReady({ statePath, home, shim, io: quietIO(), service: { ...launchd.road, waitMs: 2_000 } });
      expect(ready.session.url).toBe(`http://127.0.0.1:${next.port}`);
      expect(launchd.ran).toEqual([]);
    } finally {
      await next.done();
    }
  });

  it("a launch whose read meets the lock passing straight to a new host, which binds a while after taking it, ends on that host", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, existing, { startedBy: "service" });
    const going = existing;
    let next: Awaited<ReturnType<typeof handedOn>> | undefined;
    let dials = 0;
    const dial: typeof dialHost = async (path, o) => {
      if (dials++ === 0) {
        await going.close();
        existing = undefined;
        next = await handedOn(path, 0);
      }
      return dialHost(path, o);
    };
    try {
      const ready = await openHostReady({ statePath, home, shim, io: quietIO(), service: { ...launchd.road, waitMs: 2_000 } }, dial);
      expect(ready.session.url).toBe(`http://127.0.0.1:${next!.port}`);
      expect(launchd.ran).toEqual([]);
    } finally {
      await next?.done();
    }
  });

  it("a launch whose read meets the host closing its page before it lets go of its lock ends on the next host", async () => {
    // The order the real host shuts down in: its page closes, then its lock goes (cli.ts, the close road), so the read
    // fails while the lock still names the host that answered.
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, existing, { startedBy: "service" });
    const going = existing;
    let dials = 0;
    const dial: typeof dialHost = async (path, o) => {
      if (dials++ === 0) {
        await going.close();
        existing = undefined;
        const lock = join(home, "host.lock");
        setTimeout(() => rmSync(lock, { force: true }), 300);
      }
      return dialHost(path, o);
    };
    const ready = await openHostReady({ statePath, home, shim, io: quietIO(), service: launchd.road }, dial);
    expect(ready.session.url).toBe(`http://127.0.0.1:${launchd.host()!.port}`);
  });

  it("a launch that reads nothing from the host it attached to, which is still serving, says why rather than dialling again", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, existing);
    let dials = 0;
    const refusing: typeof dialHost = async () => {
      dials++;
      throw new Error("the host refused this computer");
    };
    await expect(openHostReady({ statePath, home, shim, io: quietIO(), service: launchd.road }, refusing)).rejects.toThrow("the host refused this computer");
    expect(dials).toBe(1);
    expect(launchd.ran).toEqual([]);
  });

  it("a serving host means no unit written", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, existing);
    const session = await open();
    expect(session.url).toBe(`http://127.0.0.1:${existing.port}`);
    expect(launchd.ran).toEqual([]);
    expect(existsSync(unitPath())).toBe(false);
  });

  it("two homes are two units, one per state file", async () => {
    await open();
    const other = join(home, "other");
    mkdirSync(other);
    const second = fakeLaunchd(join(other, "state.json"));
    try {
      await openHost({ statePath: join(other, "state.json"), home: other, shim, io: quietIO(), service: second.road });
      const units = readdirSync(join(home, "Library", "LaunchAgents")).sort();
      expect(units).toEqual([`com.wsp.host.${serviceTag(statePath)}.plist`, `com.wsp.host.${serviceTag(join(other, "state.json"))}.plist`].sort());
    } finally {
      await second.host()?.close();
    }
  });

  it("the systemd table on Linux: the same plan, written as a user unit and started through systemctl", async () => {
    const ran: string[][] = [];
    const road = { ...launchd.road, platform: "linux", manager: SERVICE_MANAGERS.systemd, run: async (argv: readonly string[]) => {
      ran.push([...argv]);
      if (argv.at(-1)?.endsWith(".service") && argv.includes("restart")) await launchd.load();
      return { code: 0, output: "" };
    } };
    await open({ service: road });
    const unit = readFileSync(join(home, ".config", "systemd", "user", `wsp-host-${serviceTag(statePath)}.service`), "utf8");
    expect(unit).toContain(`ExecStart='${shim}' 'up' '--state' '${statePath}'`);
    expect(unit).toContain("Environment='WSP_STARTED_BY=service'");
    expect(ran.map(argv => argv.slice(0, 3).join(" "))).toEqual(["systemctl --user daemon-reload", "systemctl --user enable", "systemctl --user restart"]);
  });

  it("refuses on a platform wsp writes no service for, in the one sentence wsp up --service says", async () => {
    await expect(open({ service: { ...launchd.road, platform: "win32", manager: undefined } })).rejects.toThrow(noManagerLine("win32"));
  });

  it("a service that never serves says so, with the end of its log", async () => {
    const road = { ...launchd.road, waitMs: 300, run: async () => ({ code: 0, output: "" }) };
    writeFileSync(join(home, "host.log"), "wsp: this state file was written by a newer wsp\n");
    await expect(open({ service: road })).rejects.toThrow(/wsp did not start within .*host\.log\nwsp: this state file was written by a newer wsp/s);
  });

  it("a refused load is the manager's own line", async () => {
    const road = { ...launchd.road, run: async (argv: readonly string[]) => (argv[1] === "enable" ? { code: 0, output: "" } : { code: 5, output: `Bootstrap failed: 5: Input/output error (${argv[1]})` }) };
    await expect(open({ service: road })).rejects.toThrow(/launchctl bootstrap .* exited 5 and said: Bootstrap failed: 5/);
  });

  /** A record wsp hosts wrote off the account's listing: the address the relay named, the key pinned at first
   * sight, and no token until a dial admits this computer over there. */
  const accountRecord = (over: Partial<HostRecord> = {}): HostRecord => ({
    url: "https://hbox1.boxes.example",
    deviceId: "",
    deviceToken: "",
    hostKey: "SHA256:box",
    pairedAt: "2026-09-20T10:00:00.000Z",
    via: { kind: "account", hostId: "hbox1" },
    ...over,
  });

  /** The relay record a linked host keeps beside its state file, which is what says which host on the account is
   * this computer. */
  function linkedAs(hostId: string): void {
    writeFileSync(join(home, "relay.json"), JSON.stringify({ relayUrl: "https://relay.example", hostId, token: "host-relay-token", name: hostId, linkedAt: "2026-09-20T09:00:00.000Z" }));
  }

  /** A socket that carries nothing: the dial below is asked for a token, not for a conversation. */
  const stubClient = (): Awaited<ReturnType<typeof dialHost>> => ({
    request: async <T extends Record<string, unknown>>(): Promise<T> => ({}) as T,
    events: async () => {},
    onFrame: () => () => {},
    closed: Promise.resolve(),
    closeWords: () => "",
    close: () => {},
    terminate: () => {},
  });

  /** The command line's dial as this window uses it, with the window it was given: handed an answer it writes that
   * token into the record under the alias it was aimed at, which is what the real one does on the admit road, and
   * handed none it only opens, which is every record that already holds a token. */
  function admittingDial(answered?: { deviceId: string; deviceToken: string }): { dial: typeof dialHost; dialled: string[]; windows: (number | undefined)[] } {
    const dialled: string[] = [];
    const windows: (number | undefined)[] = [];
    return {
      dialled,
      windows,
      dial: async (_statePath, opts = {}) => {
        const aim = opts.aim;
        if (aim?.kind !== "alias") throw new Error(`the window dialled ${JSON.stringify(aim)} rather than a saved host`);
        dialled.push(aim.alias);
        windows.push(opts.deadlineMs);
        if (answered !== undefined) writeHost(opts.home ?? home, aim.alias, { ...aim.record, ...answered });
        return stubClient();
      },
    };
  }

  const openWith = (dial: typeof dialHost, lines: string[] = []): Promise<HostSession> => open({ dial }, lines);

  /** The window opened on this computer's own service, which it installed and loaded. */
  const onServiceHere = (session: HostSession): void => {
    expect(session).toMatchObject({ remote: false, url: `http://127.0.0.1:${launchd.host()!.port}` });
    expect(launchd.ran.map(argv => argv[1])).toEqual(["enable", "bootstrap"]);
  };

  it("the account's host means no unit here: one dial admits this computer there and nothing is installed or started on this one", async () => {
    writeHost(home, "box", accountRecord());
    const { dial, dialled, windows } = admittingDial({ deviceId: "d_2", deviceToken: "tok-fresh" });
    const session = await openWith(dial);
    expect(dialled).toEqual(["box"]);
    // A person is watching an empty window while this dial waits, so it is well under the fifteen seconds a line
    // at a terminal gives a relayed road, and over the hold that road was measured at, which the constant names.
    expect(windows[0]).toBeGreaterThan(0);
    expect(windows[0]).toBeLessThan(10_000);
    expect(session).toMatchObject({ url: "https://hbox1.boxes.example", remote: true, alias: "box", label: "box", deviceToken: "tok-fresh" });
    expect(launchd.ran).toEqual([]);
    expect(existsSync(unitPath())).toBe(false);
    expect(existsSync(join(home, "host.lock"))).toBe(false);
  });

  it("opens on the service here when the one host on the account is this computer, which is where a line with no name goes anyway", async () => {
    writeHost(home, "macbook", accountRecord({ via: { kind: "account", hostId: "hmac" } }));
    linkedAs("hmac");
    const { dial, dialled } = admittingDial();
    onServiceHere(await openWith(dial));
    expect(dialled).toEqual([]);
  });

  it("opens on the service here and says why when the account names several hosts", async () => {
    writeHost(home, "box", accountRecord());
    writeHost(home, "attic", accountRecord({ url: "https://hattic.boxes.example", hostKey: "SHA256:attic", via: { kind: "account", hostId: "hattic" } }));
    const lines: string[] = [];
    const { dial, dialled } = admittingDial();
    onServiceHere(await openWith(dial, lines));
    expect(dialled).toEqual([]);
    expect(lines.join("\n")).toContain(severalAccountHostsLine(["attic", "box"]));
  });

  it("opens on the service here over a record a pairing code left, which names no account and is read as no record", async () => {
    mkdirSync(join(home, "hosts"), { recursive: true });
    writeFileSync(join(home, "hosts", "lan.json"), JSON.stringify({ url: "http://192.168.1.9:4400", deviceId: "d_9", deviceToken: "tok-lan", hostKey: "SHA256:lan", pairedAt: "2026-09-01T00:00:00.000Z" }));
    const { dial, dialled } = admittingDial();
    onServiceHere(await openWith(dial));
    expect(dialled).toEqual([]);
  });

  it("opens on the service here and prints the host's own sentence when the account's host refuses this computer", async () => {
    writeHost(home, "box", accountRecord());
    const lines: string[] = [];
    const refusing: typeof dialHost = async () => {
      throw Object.assign(new Error("this host admits no device under that key"), { kind: "auth" });
    };
    onServiceHere(await openWith(refusing, lines));
    expect(lines.join("\n")).toContain("this host admits no device under that key");
    // The record is left as it was: the window said what happened and opened here, and the Hosts menu still holds it.
    expect(existsSync(join(home, "hosts", "box.json"))).toBe(true);
  });

  it("refuses a record holding a token and no key for the host before it dials, as every line aimed at one is refused", async () => {
    writeHost(home, "box", accountRecord({ deviceToken: "tok-held", hostKey: undefined }));
    const lines: string[] = [];
    const { dial, dialled } = admittingDial({ deviceId: "d_2", deviceToken: "tok-fresh" });
    onServiceHere(await openWith(dial, lines));
    expect(dialled).toEqual([]);
    expect(lines.join("\n")).toContain(hostNoKeyLine("box"));
  });

  it("starts the service rather than attaching to a wsp host on a port no lock beside this state file names", async () => {
    // Any login on this computer can bind a port and serve a page with the boot line in it; the lock beside the
    // state file is what says a host of the owner's is serving, and there is none here.
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    const session = await open();
    expect(session.port).not.toBe(existing.port);
    expect(launchd.ran.map(argv => argv[1])).toEqual(["enable", "bootstrap"]);
  });

  it("attaches to the host named in host.lock when its page carries the digest of the token beside this state file, and sends that page nothing", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    // The page passes through a recorder standing where the lock says the host is, so what the window sent to
    // settle the question is read: a squatter on that port would read the same bytes.
    const seen = await recording(existing.port);
    try {
      const lock = { pid: process.pid, port: seen.port, startedAt: new Date().toISOString() };
      writeFileSync(join(home, "host.lock"), JSON.stringify(lock));
      writeFileSync(join(home, "host-token"), `${existing.authToken}\n`);

      const session = await open();
      expect(session.url).toBe(`http://127.0.0.1:${seen.port}`);
      expect(JSON.parse(readFileSync(join(home, "host.lock"), "utf8"))).toEqual(lock);
      // One read of the page, carrying no bearer and no token: the compare happened here, against the file.
      expect(seen.requests.length).toBeGreaterThan(0);
      for (const r of seen.requests) {
        expect(r.authorization).toBeUndefined();
        expect(r.url).not.toContain(existing.authToken);
      }
    } finally {
      await seen.close();
    }
  });

  it("refuses a loopback lock whose page carries another token's digest than the file beside the state, or none, and installs nothing", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: existing.port, startedAt: new Date().toISOString() }));
    writeFileSync(join(home, "host-token"), "a-token-of-some-other-host\n");
    await expect(open()).rejects.toThrow(/holds .*host\.lock on port \d+ but the page it serves carries another token's digest/);
    expect(launchd.ran).toEqual([]);

    // A page with the boot line and no digest at all: what a host bound beyond this computer serves, standing on a
    // loopback lock that says otherwise.
    const bare = createServer((_req, res) => res.end(`<html><script>window.__WSP__ = ${JSON.stringify({ wsPath: "/ws", paired: true, version: "0.0.0" })};</script></html>`));
    const barePort = await listen(bare);
    try {
      writeFileSync(join(home, "host-token"), `${existing.authToken}\n`);
      writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: barePort, startedAt: new Date().toISOString() }));
      await expect(open()).rejects.toThrow(/but the page it serves carries another token's digest/);
    } finally {
      await closeServer(bare);
    }
    expect(existsSync(unitPath())).toBe(false);
  });

  it("refuses a loopback lock with no wsp host answering on its port, which is the stale lock a squatter took", async () => {
    const squatter = createServer((_req, res) => res.end("<html>hello</html>"));
    const port = await listen(squatter);
    try {
      writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
      await expect(open()).rejects.toThrow(/but no wsp host answers there/);
    } finally {
      await closeServer(squatter);
    }
  });

  it.runIf(ipv6Loopback)("dials a loopback lock where its address says that host answers, not this computer's other loopback name", async () => {
    // A host up with --listen ::1 binds a loopback address, so its page carries its token's digest, and it answers
    // there and nowhere else.
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, listen: "::1", statePath });
    serving(statePath, existing, { address: "::1" });
    expect((await open()).url).toBe(`http://[::1]:${existing.port}`);
  });

  it("attaches through the lock alone to a host bound beyond this computer, whose page carries no digest by design", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, listen: "0.0.0.0", statePath });
    // No token file is written and none is asked for: that page inlines no digest, and the lock is the whole reading.
    writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: existing.port, address: "0.0.0.0", startedAt: new Date().toISOString() }));
    expect((await open()).url).toBe(`http://127.0.0.1:${existing.port}`);
  });

  it.runIf(process.getuid !== undefined && process.getuid() !== 0)("refuses a lock naming a process of another login, whatever answers on its port", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, existing, { pid: 1 });
    await expect(open()).rejects.toThrow(/but that process is not this login's/);
  });

  it("ignores a host.lock whose pid is gone and starts the service", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0 });
    serving(statePath, existing, { pid: deadPid() });
    const session = await open();
    expect(session.port).toBe(launchd.host()!.port);
    expect(launchd.ran.map(argv => argv[1])).toEqual(["enable", "bootstrap"]);
  });
});

describe("the first launch, read off the host", () => {
  let home: string;
  let statePath: string;
  let host: HostHandle | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-desktop-first-"));
    statePath = join(home, "state.json");
  });
  afterEach(async () => {
    await host?.close();
    host = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  async function served(runtime: Runtime): Promise<void> {
    host = await startHost({ runtime, webDir: fakeWebDir(), port: 0 });
    serving(statePath, host);
  }

  it("is the first launch where the host holds no golden and no workspace", async () => {
    await served(testRuntime());
    expect(await firstLaunch(statePath, home)).toBe(true);
  });

  it("is not where a golden is sealed, which is what wsp init leaves", async () => {
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [{ version: 1, snapshotId: "snap", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z" }] });
    await served(createRuntime({ backend: stubBackend(), store, adapters: {} }));
    expect(await firstLaunch(statePath, home)).toBe(false);
  });

  it("is not where a workspace of this computer is recorded, with no provider key at all", async () => {
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    try {
      // The copy road alone is faked: every workspace here is a copy, and this checkout stages no daemon binary.
      const runtime = makeRuntime({}, statePath, undefined, process.env, undefined, localWiring(home, process.env, fakeDaemonStart, statePath, copyingFake()));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-lifecycle-")));
      execFileSync("git", ["init", "-q", folder]);
      const project = await runtime.projects.add({ source: folder, name: "thisbox" });
      await runtime.workspaces.create({ project: project.id, name: "thisbox" });
      await served(runtime);
      expect(await firstLaunch(statePath, home)).toBe(false);
      expect(existsSync(localWorkFolder(home))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("quit and stop wsp", () => {
  let home: string;
  let statePath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-desktop-stop-"));
    statePath = join(home, "state.json");
    vi.stubEnv("HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const sessions = [
    { id: "s_mac", workspaceId: "ws_mac", status: "running" as const },
    { id: "s_asks", workspaceId: "ws_mac", status: "running" as const },
    { id: "s_done", workspaceId: "ws_mac", status: "completed" as const },
    { id: "s_box", workspaceId: "ws_box", status: "running" as const },
  ];
  const workspaces = [
    { id: "ws_mac", kind: "local" as const },
    { id: "ws_box", kind: "cloud" as const },
  ];

  /** A socket to the host here answering the two lists and taking each interrupt it is sent. */
  function hostHere(): { dial: typeof dialHost; interrupted: string[] } {
    const interrupted: string[] = [];
    const client = {
      request: async <T extends Record<string, unknown>>(op: string, params?: Record<string, unknown>): Promise<T> => {
        if (op === "sessions.list") return { sessions } as unknown as T;
        if (op === "workspaces.list") return { workspaces } as unknown as T;
        if (op === "sessions.interrupt") interrupted.push(String(params?.["sessionId"]));
        return {} as T;
      },
      events: async () => {},
      onFrame: () => () => {},
      closed: Promise.resolve(),
      closeWords: () => "",
      close: () => {},
      terminate: () => {},
    };
    return { interrupted, dial: async () => client };
  }

  it("counts the turns running on this computer's own workspaces, never a box's, whose turns go on without wsp here", () => {
    expect(runningHere(sessions, workspaces)).toEqual(["s_mac", "s_asks"]);
  });

  it("interrupts every turn on this computer, then stops the service and takes its unit away", async () => {
    const launchd = fakeLaunchd(statePath);
    await ensureService({ statePath, home, shim: join(home, "bin", "wsp"), service: launchd.road, io: quietIO() });
    const { dial, interrupted } = hostHere();
    expect(await workingHere(statePath, home, dial)).toBe(2);
    launchd.ran.length = 0;
    await stopWsp(statePath, home, launchd.road, dial);
    expect(interrupted).toEqual(["s_mac", "s_asks"]);
    expect(launchd.ran.map(argv => argv[1])).toEqual(["print", "bootout"]);
    expect(launchd.loaded()).toBe(false);
    expect(existsSync(SERVICE_MANAGERS.launchd.unit(serviceAddressHere(statePath)).path)).toBe(false);
    expect(existsSync(join(home, "host.lock"))).toBe(false);
    expect(await workingHere(statePath, home, dial)).toBe(0);
  });
});

describe("homeOf", () => {
  it("names ~/.wsp where the launch names no home, and the home WSP_HOME names where it does", () => {
    vi.stubEnv("HOME", "/Users/someone");
    try {
      expect(homeOf({ packaged: true, cwd: "/" })).toBe(join("/Users/someone", ".wsp"));
      expect(homeOf({ packaged: true, cwd: "/", env: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("hostTokenMatches", () => {
  it("matches only the digest of the exact bytes of the token file beside the state, never the token itself, and nothing at all where there is no file", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-desktop-token-"));
    const statePath = join(dir, "state.json");
    try {
      expect(hostTokenMatches(statePath, digestOf("a-token"))).toBe(false);
      writeFileSync(join(dir, "host-token"), "a-token\n");
      expect(hostTokenMatches(statePath, digestOf("a-token"))).toBe(true);
      // The token in the clear is not its digest: a page carrying the token would be refused, as it should be.
      expect(hostTokenMatches(statePath, "a-token")).toBe(false);
      expect(hostTokenMatches(statePath, digestOf("a-token "))).toBe(false);
      expect(hostTokenMatches(statePath, digestOf("A-TOKEN"))).toBe(false);
      expect(hostTokenMatches(statePath, digestOf("a-toke"))).toBe(false);
      expect(hostTokenMatches(statePath, digestOf("a-token").toUpperCase())).toBe(false);
      expect(hostTokenMatches(statePath, "")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("statePathIn", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-desktop-home-"));
    cwd = mkdtempSync(join(tmpdir(), "wsp-desktop-cwd-"));
    // What makes a folder a checkout of wsp: its own root package.json naming the workspace.
    writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "wsp", private: true })}\n`);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("shares the checkout's state with wspx when a development run is launched from a checkout of wsp", () => {
    expect(statePathIn(home, { packaged: false, cwd })).toBe(join(cwd, ".wsp", "state.json"));
  });

  it("keeps a packaged app's state in the home, whatever the folder it was launched from holds", () => {
    expect(statePathIn(home, { packaged: true, cwd })).toBe(join(home, "state.json"));
  });

  it("lets WSP_HOME win over the launch folder, packaged or not, which is what the locate doc says", () => {
    for (const packaged of [true, false]) expect(statePathIn(home, { packaged, cwd, env: home })).toBe(join(home, "state.json"));
  });

  it("reads an empty WSP_HOME as none set, so a development run still shares the checkout's state", () => {
    expect(statePathIn(home, { packaged: false, cwd, env: "" })).toBe(join(cwd, ".wsp", "state.json"));
  });

  it("takes the home when the launch folder is no checkout, packaged or not", () => {
    const bare = mkdtempSync(join(tmpdir(), "wsp-desktop-bare-"));
    for (const packaged of [true, false]) expect(statePathIn(home, { packaged, cwd: bare })).toBe(join(home, "state.json"));
    rmSync(bare, { recursive: true, force: true });
  });
});

describe("userDataIn", () => {
  let user: string;
  let cwd: string;

  beforeEach(() => {
    user = mkdtempSync(join(tmpdir(), "wsp-desktop-user-"));
    cwd = join(user, "cwd");
    mkdirSync(cwd);
    vi.stubEnv("HOME", user);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(user, { recursive: true, force: true });
  });

  it("puts Chromium's files beside the state file of the home the launch names, so two apps on two homes share no profile", () => {
    const custom = join(user, "custom-home");
    expect(userDataIn({ packaged: true, cwd, env: custom })).toBe(join(custom, "desktop"));
    expect(userDataIn({ packaged: true, cwd })).toBe(join(user, ".wsp", "desktop"));
    expect(userDataIn({ packaged: true, cwd, env: custom })).not.toBe(userDataIn({ packaged: true, cwd }));
  });

  it("follows the state file a development run shares with wspx, which sits in the checkout", () => {
    writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "wsp", private: true })}\n`);
    expect(userDataIn({ packaged: false, cwd })).toBe(join(cwd, ".wsp", "desktop"));
    // WSP_HOME wins over the checkout, packaged or not, as the state file does.
    const custom = join(user, "custom-home");
    expect(userDataIn({ packaged: false, cwd, env: custom })).toBe(join(custom, "desktop"));
  });
});
