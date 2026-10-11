// SPDX-License-Identifier: AGPL-3.0-only
// The launch's wait on the service it started: as long as the host's process lives and moves, and one line with the
// log behind a button once it has gone.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVICE_MANAGERS, dialHost, httpProbe, startHost, type CliIO, type HostHandle, type ServiceDeps, type ServiceRunner } from "@wsp/host";
import { createRuntime, memoryStore } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVICE_WAIT_MS } from "../../../packages/host/src/host-lock.js";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { StartFailed, openHostReady, type OpenHostOptions } from "../src/host-lifecycle.js";
import { OPEN_LOG, QUIT, sayStartFailed, startFailedDialog, startingAfter } from "../src/starting.js";

const PAGE = `<html><body><script>window.__WSP__ = window.__WSP__ || { token: "" };</script></body></html>`;
const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const noAsk = (prompt: { message: string }): Promise<boolean> => Promise.reject(new Error(`unexpected ask: ${prompt.message}`));

let home: string;
let statePath: string;
let logPath: string;
let lines: string[];
const children: ChildProcess[] = [];
let host: HostHandle | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wsp-start-wait-"));
  statePath = join(home, "state.json");
  logPath = join(home, "host.log");
  lines = [];
  vi.stubEnv("HOME", home);
  vi.stubEnv("WSP_HOME", home);
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await host?.close();
  host = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const io = (): CliIO => ({ log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt });

/** A process standing in for the host the manager runs: alive until killed, or for as long as its script runs. The
 * one alive until killed is the sleep itself, since killing a shell leaves the sleep it started running. */
function hostProcess(script?: string): ChildProcess {
  const child = script === undefined ? spawn("sleep", ["120"], { stdio: "ignore" }) : spawn("sh", ["-c", script], { stdio: "ignore" });
  children.push(child);
  return child;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as { port: number };
  await new Promise(r => probe.close(r));
  return port;
}

/** Serves a real host on the port and writes its lock and token as `wsp up` does, under the given pid. */
async function serveAs(pid: number, port: number): Promise<void> {
  const web = join(home, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), PAGE);
  host = await startHost({ runtime: createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} }), webDir: web, port });
  writeFileSync(join(home, "host-token"), `${host.authToken}\n`);
  writeFileSync(join(home, "host.lock"), JSON.stringify({ pid, port, startedAt: new Date().toISOString(), startedBy: "service" }));
}

/** launchd as the launch reads it, with nothing serving yet: `print` names the process the unit runs, which
 * `bootstrap` starts through `start`, and starts again once it has exited where the unit is kept alive. */
function launchd(start: () => ChildProcess | undefined, waitMs = SERVICE_WAIT_MS, keepAlive = false): { road: ServiceDeps } {
  let current: ChildProcess | undefined;
  let loaded = false;
  const run: ServiceRunner = async argv => {
    const verb = argv[1];
    if (verb === "print") {
      if (!loaded) return { code: 113, output: "Could not find service" };
      const exited = current !== undefined && (current.exitCode !== null || current.signalCode !== null);
      if (exited && keepAlive) current = start();
      const alive = current !== undefined && current.exitCode === null && current.signalCode === null;
      return { code: 0, output: alive ? `\tstate = running\n\tpid = ${current!.pid}\n` : "\tstate = not running\n" };
    }
    if (verb === "bootstrap") {
      loaded = true;
      current = start();
    }
    return { code: 0, output: "" };
  };
  return {
    road: { platform: "darwin", manager: SERVICE_MANAGERS.launchd, run, waitMs, answers: httpProbe, keys: { env: {}, cwd: tmpdir() }, dial: dialHost, stop: () => {}, here: async () => undefined },
  };
}

function options(service: ServiceDeps): OpenHostOptions {
  return { statePath, home, shim: join(home, "bin", "wsp"), io: io(), ask: noAsk, service };
}

describe("the launch's wait on a host that is starting", () => {
  it("opens on a host that takes 40 s to start while its process lives, showing that it is starting meanwhile", async () => {
    expect(SERVICE_WAIT_MS).toBe(20_000);
    // The host the manager runs reads its machines for 40 s before it takes its lock and serves, saying so in its
    // log as it goes, as a host whose boxes and provider answer slowly does.
    const port = await freePort();
    let ticker: ReturnType<typeof setInterval> | undefined;
    let serving: ReturnType<typeof setTimeout> | undefined;
    const service = launchd(() => {
      const child = hostProcess();
      ticker = setInterval(() => appendFileSync(logPath, `daemon on bx_${Date.now()}: version not read within 5 s; asking again at the next reach probe\n`), 5_000);
      serving = setTimeout(() => {
        clearInterval(ticker);
        void serveAs(child.pid!, port);
      }, 40_000);
      return child;
    });
    const shown: string[] = [];
    const starting = startingAfter(() => {
      shown.push("starting");
      return () => shown.push("gone");
    });
    try {
      const ready = await openHostReady(options(service.road));
      starting.end();
      expect(ready.session.url).toBe(`http://127.0.0.1:${port}`);
      expect(shown).toEqual(["starting", "gone"]);
    } finally {
      clearInterval(ticker);
      clearTimeout(serving);
      starting.end();
    }
  }, 60_000);

  it("gives up on a host whose process lives and has neither answered nor written a line for the longer wait", async () => {
    const service = launchd(() => hostProcess(), 300);
    const failed = await openHostReady(options(service.road)).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(StartFailed);
    // Six of the 300 ms waits with nothing moving.
    expect((failed as StartFailed).message).toMatch(/^wsp did not start within \d\.\ds: it neither answered nor wrote to its log$/);
  }, 10_000);

  it("a host that exits as it starts is one line naming what it said, with its log to open, and the log's lines in the app's log", async () => {
    // Under KeepAlive the manager starts it again after it exits, and that one exits as well.
    const script = `sleep 0.5; echo "listening on 127.0.0.1:4400" >> '${logPath}'; echo "wsp: port 4400 is held by another program" >> '${logPath}'; exit 1`;
    const service = launchd(() => hostProcess(script), 5_000, true);
    const t0 = Date.now();
    const failed = await openHostReady(options(service.road)).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(StartFailed);
    expect((failed as StartFailed).message).toBe("wsp stopped as it started: wsp: port 4400 is held by another program");
    expect((failed as StartFailed).logPath).toBe(logPath);
    expect(lines).toContain("host: wsp: port 4400 is held by another program");
    // Two of its processes were seen to exit, so the wait did not run out the whole start's wait for another.
    expect(Date.now() - t0).toBeLessThan(5_000);

    const { options: dialog, logPath: opens } = startFailedDialog("wsp could not start", failed, { host: logPath, app: join(home, "logs", "app.log") });
    expect(dialog.message).toBe("wsp could not start");
    expect(dialog.detail).toBe("wsp stopped as it started: wsp: port 4400 is held by another program");
    expect(dialog.detail).not.toContain("\n");
    expect(dialog.buttons).toEqual(["Open log", "Quit"]);
    expect(opens).toBe(logPath);
    const opened: string[] = [];
    const quits: string[] = [];
    const ui = (response: number) => ({ show: async () => ({ response }), open: async (path: string) => (opened.push(path), ""), quit: () => void quits.push("quit") });
    await sayStartFailed("wsp could not start", failed, { host: logPath, app: "" }, ui(OPEN_LOG));
    expect([opened, quits]).toEqual([[logPath], []]);
    await sayStartFailed("wsp could not start", failed, { host: logPath, app: "" }, ui(QUIT));
    expect([opened, quits]).toEqual([[logPath], ["quit"]]);
  }, 20_000);

  it("a host the manager never runs is one line saying so", async () => {
    const service = launchd(() => undefined, 400);
    const failed = await openHostReady(options(service.road)).catch((e: unknown) => e);
    expect((failed as StartFailed).message).toMatch(/^wsp did not start within \d+ms: nothing ran its service$/);
  });
});

describe("the dialog a failed start shows", () => {
  it("quits on Quit when it answers a later open, where no window is left whose closing would quit", async () => {
    const quits: string[] = [];
    const opened: string[] = [];
    await sayStartFailed("wsp could not open", new Error("wsp stopped as it started: a reason"), { host: logPath, app: join(home, "logs", "app.log") }, {
      show: async options => ({ response: options.cancelId! }),
      open: async path => (opened.push(path), ""),
      quit: () => void quits.push("quit"),
    });
    expect([quits, opened]).toEqual([["quit"], []]);
  });

  it("takes the first line of any other failure and opens the host's log where one was written, else the app's", () => {
    const app = join(home, "logs", "app.log");
    expect(startFailedDialog("wsp could not open", new Error("a refusal\nand what came after it"), { host: logPath, app })).toMatchObject({ options: { detail: "a refusal" }, logPath: app });
    writeFileSync(logPath, "wsp: something\n");
    expect(startFailedDialog("wsp could not open", "said as a string", { host: logPath, app }).logPath).toBe(logPath);
  });
});
