// SPDX-License-Identifier: AGPL-3.0-only
// The host as a service of the computer's own manager, against a fake one:
// nothing here runs launchctl or systemctl, so the modules are read for the
// unit files they write and the commands they hand over.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NOTHING_TO_SERVE_LINE } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeKeyOnlyInThisShell, downCommand, keyOnlyInThisShell, statusCommand, upServiceCommand, type CliIO, type ServiceDeps } from "../src/cli.js";
import {
  SERVICE_MANAGERS,
  installService,
  logTail,
  noManagerLine,
  serviceEnv,
  serviceManagerFor,
  serviceReading,
  serviceTag,
  statusLines,
  stopService,
  untilLock,
  type ServiceAddress,
  type ServiceManager,
  type ServicePlan,
  type ServiceRunner,
} from "../src/service.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
function quietIO(lines: string[] = [], errors: string[] = []): CliIO {
  return { log: l => lines.push(l), error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt };
}

const KEY = "slr_live_fake_service_key";

/** This computer as wsp init's local road records it: kind local, no golden, running while a host is up. */
const LOCAL_RECORD = {
  id: "ws_1",
  name: "mybox",
  kind: "local",
  machineId: "local",
  phase: "running",
  golden: "",
  createdAt: "2026-09-08T00:00:00.000Z",
  spec: {},
  size: { cpu: 2, memMb: 4032 },
  firstLife: false,
};

function planFor(at: ServiceAddress, over: Partial<ServicePlan> = {}): ServicePlan {
  return {
    ...at,
    argv: ["/usr/bin/node", "/opt/wsp/bin.js", "up", "--state", at.statePath, "--port", "4400", "--ws-port", "4410"],
    cwd: "/Users/z/work",
    env: { PATH: "/usr/bin:/bin" },
    logPath: join(dirname(at.statePath), "host.log"),
    ...over,
  };
}

describe("one module per service manager", () => {
  const at: ServiceAddress = { statePath: "/Users/z/.wsp/state.json", home: "/Users/z", uid: 501 };
  const tag = serviceTag(at.statePath);

  it("the launchd agent runs the wsp line at load and again at every login, and holds no key", () => {
    const launchd = SERVICE_MANAGERS.launchd;
    expect(launchd.unit(at)).toEqual({ name: `com.wsp.host.${tag}`, path: `/Users/z/Library/LaunchAgents/com.wsp.host.${tag}.plist` });
    const text = launchd.text(planFor(at, { env: { PATH: "/usr/bin:/bin", WSP_HOME: "/Users/z/.wsp" } }));
    expect(text).toContain(`<key>Label</key><string>com.wsp.host.${tag}</string>`);
    expect(text).toContain("    <string>/opt/wsp/bin.js</string>\n    <string>up</string>\n    <string>--state</string>\n    <string>/Users/z/.wsp/state.json</string>");
    expect(text).toContain("<key>RunAtLoad</key><true/>");
    expect(text).toContain("<key>KeepAlive</key><true/>");
    expect(text).toContain("<key>WorkingDirectory</key><string>/Users/z/work</string>");
    expect(text).toContain("<key>PATH</key><string>/usr/bin:/bin</string>");
    expect(text).toContain("<key>WSP_HOME</key><string>/Users/z/.wsp</string>");
    expect(text).toContain("<key>StandardOutPath</key><string>/Users/z/.wsp/host.log</string>");
    expect(text).not.toContain(KEY);
    expect(launchd.load(at)).toEqual([["launchctl", "bootstrap", "gui/501", `/Users/z/Library/LaunchAgents/com.wsp.host.${tag}.plist`]]);
    expect(launchd.unload(at)).toEqual([["launchctl", "bootout", `gui/501/com.wsp.host.${tag}`]]);
    expect(launchd.holds(at)).toEqual(["launchctl", "print", `gui/501/com.wsp.host.${tag}`]);
    expect(launchd.afterLoad).toBeUndefined();
  });

  it("the systemd user unit restarts the host, comes back at login, and says what a user unit alone asks for", () => {
    const systemd = SERVICE_MANAGERS.systemd;
    expect(systemd.unit(at)).toEqual({ name: `wsp-host-${tag}.service`, path: `/Users/z/.config/systemd/user/wsp-host-${tag}.service` });
    const text = systemd.text(planFor(at));
    expect(text).toContain("ExecStart='/usr/bin/node' '/opt/wsp/bin.js' 'up' '--state' '/Users/z/.wsp/state.json' '--port' '4400' '--ws-port' '4410'");
    expect(text).toContain("WorkingDirectory='/Users/z/work'");
    expect(text).toContain("Environment='PATH=/usr/bin:/bin'");
    expect(text).toContain("Restart=always");
    expect(text).toContain("StandardOutput=append:/Users/z/.wsp/host.log");
    expect(text).toContain("WantedBy=default.target");
    expect(text).not.toContain(KEY);
    expect(systemd.load(at)).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", `wsp-host-${tag}.service`],
    ]);
    expect(systemd.unload(at)).toEqual([
      ["systemctl", "--user", "disable", "--now", `wsp-host-${tag}.service`],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(systemd.holds(at)).toEqual(["systemctl", "--user", "is-enabled", `wsp-host-${tag}.service`]);
    expect(systemd.afterLoad?.(at)).toContain("enable-linger");
  });

  it("the platform picks the module, an unknown one gets a line naming the two that exist, and two state files never share a unit", () => {
    expect(serviceManagerFor("darwin")).toBe(SERVICE_MANAGERS.launchd);
    expect(serviceManagerFor("linux")).toBe(SERVICE_MANAGERS.systemd);
    expect(serviceManagerFor("win32")).toBeUndefined();
    expect(noManagerLine("win32")).toBe("wsp writes no service on win32; it writes a launchd agent on darwin and a systemd user unit on linux. Run wsp up in a terminal that stays open instead.");
    const other: ServiceAddress = { ...at, statePath: "/Users/z/work/.wsp/state.json" };
    expect(SERVICE_MANAGERS.launchd.unit(other).name).not.toBe(SERVICE_MANAGERS.launchd.unit(at).name);
  });

  it("a service starts with the PATH the install had and WSP_HOME when it moved the state folder, and never a key", () => {
    expect(serviceEnv({ PATH: "/opt/homebrew/bin:/usr/bin", SOLARI_API_KEY: KEY })).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin" });
    expect(serviceEnv({ PATH: "/usr/bin", WSP_HOME: "/Users/z/dev/.wsp" })).toEqual({ PATH: "/usr/bin", WSP_HOME: "/Users/z/dev/.wsp" });
    expect(serviceEnv({}).PATH).toContain("/usr/bin");
  });

  it("each manager reads its own holds answer: what it says for a service it does not have, and what it says when it could not answer at all", () => {
    const launchd = SERVICE_MANAGERS.launchd;
    expect(launchd.absent({ code: 113, output: `Could not find service "com.wsp.host.${tag}" in domain for user` })).toBe(true);
    expect(launchd.absent({ code: 127, output: "launchctl: command not found" })).toBe(false);
    expect(launchd.absent({ code: 5, output: "Bootstrap failed: 5: Input/output error" })).toBe(false);

    const systemd = SERVICE_MANAGERS.systemd;
    expect(systemd.absent({ code: 1, output: "disabled" })).toBe(true);
    expect(systemd.absent({ code: 1, output: `Failed to get unit file state for wsp-host-${tag}.service: No such file or directory` })).toBe(true);
    // Measured on a Linux box with no user bus: is-enabled exits 1 there too, so the code alone cannot tell the two apart.
    expect(systemd.absent({ code: 1, output: "Failed to connect to bus: No medium found" })).toBe(false);
    expect(systemd.absent({ code: 127, output: "systemctl: command not found" })).toBe(false);
    expect(systemd.absent({ code: 0, output: "enabled" })).toBe(false);
  });
});

/** A manager that writes a file and answers commands, standing in for launchd here: load starts a host by writing
 * the lock the real one's host would take, unload takes it away again. */
function fakeService(over: Partial<ServiceDeps> = {}): { deps: ServiceDeps; manager: ServiceManager; run: ServiceRunner; ran: string[][]; plans: ServicePlan[]; fail: (verb: string) => void; starts: (yes: boolean) => void; mute: () => void } {
  const ran: string[][] = [];
  const plans: ServicePlan[] = [];
  const failing = new Set<string>();
  let held = false;
  let starts = true;
  let mute = false;
  const unit = (a: ServiceAddress): { name: string; path: string } => ({ name: `fake.${serviceTag(a.statePath)}`, path: join(a.home, "fake-units", `${serviceTag(a.statePath)}.unit`) });
  const lockPath = (a: ServiceAddress): string => join(dirname(a.statePath), "host.lock");
  let address: ServiceAddress | undefined;
  const manager: ServiceManager = {
    words: "fake service",
    unit: a => {
      address = a;
      return unit(a);
    },
    text: plan => {
      plans.push(plan);
      return `fake ${plan.argv.join(" ")}\n`;
    },
    load: a => [["fake", "load", unit(a).name]],
    unload: a => [["fake", "unload", unit(a).name]],
    holds: a => ["fake", "holds", unit(a).name],
    absent: answer => answer.output === "not held",
  };
  const run: ServiceRunner = async argv => {
    ran.push([...argv]);
    const verb = argv[1]!;
    if (failing.has(verb)) return { code: 3, output: `fake ${verb} refused` };
    if (verb === "load") {
      held = true;
      if (starts && address !== undefined) writeFileSync(lockPath(address), JSON.stringify({ pid: process.pid, port: 4400, wsPort: 4410, startedAt: new Date().toISOString() }));
      return { code: 0, output: "" };
    }
    if (verb === "unload") {
      held = false;
      if (address !== undefined) rmSync(lockPath(address), { force: true });
      return { code: 0, output: "" };
    }
    if (mute) return { code: 1, output: "fake holds could not say" };
    return held ? { code: 0, output: "" } : { code: 1, output: "not held" };
  };
  return {
    run,
    deps: {
      platform: "fake-os",
      manager,
      run,
      waitMs: 0,
      keys: { env: process.env, cwd: tmpdir(), home: tmpdir() },
      answers: () => Promise.resolve(true),
      ...over,
    },
    manager,
    ran,
    plans,
    fail: verb => void failing.add(verb),
    starts: yes => {
      starts = yes;
    },
    mute: () => {
      mute = true;
    },
  };
}

describe("installing, stopping and reading a service", () => {
  let home: string;
  let at: ServiceAddress;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-service-"));
    mkdirSync(join(home, ".wsp"), { recursive: true });
    at = { statePath: join(home, ".wsp", "state.json"), home, uid: 501 };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("writes the unit file as the person's own and hands it to the manager in order", async () => {
    const fake = fakeService();
    const { unit, failure } = await installService(fake.manager, planFor(at), fake.run);
    expect(failure).toBeUndefined();
    expect(readFileSync(unit.path, "utf8")).toContain("fake /usr/bin/node");
    expect(statSync(unit.path).mode & 0o777).toBe(0o600);
    expect(fake.ran).toEqual([["fake", "load", unit.name]]);
  });

  it("a load the manager refuses leaves no unit file behind and says what it ran and what it answered", async () => {
    const fake = fakeService();
    fake.fail("load");
    const { unit, failure } = await installService(fake.manager, planFor(at), fake.run);
    expect(existsSync(unit.path)).toBe(false);
    expect(failure?.result).toEqual({ code: 3, output: "fake load refused" });
  });

  it("a refused load leaves a unit file this call did not write where it stands, since the manager may still hold what it names", async () => {
    const fake = fakeService();
    const before = fake.manager.unit(at);
    mkdirSync(dirname(before.path), { recursive: true });
    writeFileSync(before.path, "an install before this one\n");
    fake.fail("load");
    const { unit, installed, failure } = await installService(fake.manager, planFor(at), fake.run);
    expect(failure?.result).toEqual({ code: 3, output: "fake load refused" });
    expect(installed).toBe(true);
    expect(existsSync(unit.path)).toBe(true);
  });

  it("a stop unloads a held service and takes the file; one the manager no longer holds is not asked to stop, and the file still goes", async () => {
    const fake = fakeService();
    const { unit } = await installService(fake.manager, planFor(at), fake.run);
    fake.ran.length = 0;
    expect((await stopService(fake.manager, at, fake.run)).failure).toBeUndefined();
    expect(fake.ran).toEqual([["fake", "holds", unit.name], ["fake", "unload", unit.name]]);
    expect(existsSync(unit.path)).toBe(false);

    writeFileSync(unit.path, "left over\n");
    fake.ran.length = 0;
    expect((await stopService(fake.manager, at, fake.run)).failure).toBeUndefined();
    expect(fake.ran).toEqual([["fake", "holds", unit.name]]);
    expect(existsSync(unit.path)).toBe(false);
  });

  it("a stop the manager refuses keeps the unit file, so nothing is left loaded with no file naming it", async () => {
    const fake = fakeService();
    const { unit } = await installService(fake.manager, planFor(at), fake.run);
    fake.fail("unload");
    const { failure } = await stopService(fake.manager, at, fake.run);
    expect(failure?.argv).toEqual(["fake", "unload", unit.name]);
    expect(existsSync(unit.path)).toBe(true);
  });

  it("a holds answer the manager cannot read unloads nothing and leaves the unit file, since taking it away is a service wsp down could no longer stop", async () => {
    const fake = fakeService();
    const { unit } = await installService(fake.manager, planFor(at), fake.run);
    fake.mute();
    fake.ran.length = 0;
    const { held, unsure, failure } = await stopService(fake.manager, at, fake.run);
    expect(held).toBe(false);
    expect(unsure?.argv).toEqual(["fake", "holds", unit.name]);
    expect(unsure?.result).toEqual({ code: 1, output: "fake holds could not say" });
    expect(failure).toBeUndefined();
    expect(fake.ran).toEqual([["fake", "holds", unit.name]]);
    expect(existsSync(unit.path)).toBe(true);
  });

  it("the service row reads none, loaded or installed and not loaded, and names the platform when wsp writes no unit for it", async () => {
    const fake = fakeService();
    expect(await serviceReading(undefined, at, fake.run, "win32")).toBe("none; wsp writes no service on win32");
    expect(await serviceReading(fake.manager, at, fake.run, "fake-os")).toBe("none; wsp up --service installs a fake service");
    const { unit } = await installService(fake.manager, planFor(at), fake.run);
    expect(await serviceReading(fake.manager, at, fake.run, "fake-os")).toBe(`fake service ${unit.name}, loaded (${unit.path})`);
    await stopService(fake.manager, at, fake.run);
    writeFileSync(unit.path, "left over\n");
    expect(await serviceReading(fake.manager, at, fake.run, "fake-os")).toBe(`fake service ${unit.name}, installed and not loaded (${unit.path})`);
  });

  it("waits for the lock to say the host took the state file, and gives up with what it last read", async () => {
    const lockPath = join(home, ".wsp", "host.lock");
    let polls = 0;
    const sleep = async (): Promise<void> => {
      if (++polls === 2) writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port: 4400, wsPort: 4410, startedAt: new Date().toISOString() }));
    };
    expect((await untilLock(at.statePath, true, 5_000, sleep))?.port).toBe(4400);
    expect(polls).toBe(2);
    expect(await untilLock(at.statePath, false, 0, sleep)).toBeDefined();
    rmSync(lockPath);
    expect(await untilLock(at.statePath, false, 0, sleep)).toBeUndefined();
  });

  it("the log tail is the last lines the service wrote, and nothing at all before it has written any", () => {
    const logPath = join(home, ".wsp", "host.log");
    expect(logTail(logPath)).toEqual([]);
    writeFileSync(logPath, "one\n\ntwo\nthree\n");
    expect(logTail(logPath, 2)).toEqual(["two", "three"]);
  });

  it("the log tail reads the end of a log both managers append to forever, not the whole of it", () => {
    const logPath = join(home, ".wsp", "host.log");
    writeFileSync(logPath, `first ${"x".repeat(200_000)}\ntail one\ntail two\n`);
    expect(logTail(logPath)).toEqual(["tail one", "tail two"]);
  });

  it("status is one row per fact: the host and where it serves, or that it does not, then the state file and the service", () => {
    const startedAt = new Date("2026-09-07T01:00:00.000Z").toISOString();
    const now = Date.parse("2026-09-07T03:05:00.000Z");
    const lock = { pid: 42, port: 4400, wsPort: 4410, startedAt };
    expect(statusLines(at.statePath, { lock, answering: true }, "fake service x, loaded", now)).toEqual([
      "host        running (pid 42, up 125m)",
      "app         http://127.0.0.1:4400",
      `runtime ws  ws://127.0.0.1:4410 (token: ${join(home, ".wsp", "host-token")})`,
      `state       ${at.statePath}`,
      "service     fake service x, loaded",
    ]);
    expect(statusLines(at.statePath, { lock, answering: false }, "fake service x, loaded", now)[0]).toBe("host        not answering on port 4400 (pid 42, up 125m)");
    expect(statusLines(at.statePath, undefined, "none; wsp up --service installs a fake service")).toEqual([
      "host        not running",
      `state       ${at.statePath}`,
      "service     none; wsp up --service installs a fake service",
    ]);
  });
});

describe("wsp up --service, wsp down and wsp status", () => {
  let home: string;
  let statePath: string;
  let opts: { port: number; wsPort: number; statePath: string };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-service-cli-"));
    mkdirSync(join(home, ".wsp"), { recursive: true });
    statePath = join(home, ".wsp", "state.json");
    opts = { port: 4400, wsPort: 4410, statePath };
    writeFileSync(statePath, JSON.stringify({ goldens: { default: SEALED_GOLDEN } }));
    vi.stubEnv("HOME", home);
    vi.stubEnv("WSP_HOME", join(home, ".wsp"));
    // Both keys are pinned off the computer running the suite: one exported in that shell is one of these tests'
    // own layers, and the notes and refusals here are all about which layer holds a key.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  const keyInFile = (): void => writeFileSync(join(home, ".wsp", ".env"), `SOLARI_API_KEY=${KEY}\n`);

  /** The fake with this test's own home as the layers a key is read from, so no .env beside the checkout wsp runs in
   * can answer for one of them. */
  const svc = (over: Partial<ServiceDeps> = {}): ReturnType<typeof fakeService> =>
    fakeService({ keys: { env: process.env, cwd: home, home: join(home, ".wsp") }, ...over });

  it("installs the service, waits for the host it starts, and prints where it serves and how to stop it", async () => {
    keyInFile();
    const fake = svc();
    const lines: string[] = [];
    const errors: string[] = [];
    expect(await upServiceCommand(quietIO(lines, errors), opts, fake.deps)).toBe(0);
    expect(errors).toEqual([]);
    const plan = fake.plans[0]!;
    expect(plan.argv[0]).toBe(process.execPath);
    expect(plan.argv.slice(2)).toEqual(["up", "--state", statePath, "--port", "4400", "--ws-port", "4410"]);
    expect(plan.env["PATH"]).toBeDefined();
    expect(JSON.stringify(plan)).not.toContain(KEY);
    expect(lines).toEqual([
      `fake service fake.${serviceTag(statePath)} is loaded; it serves again at every login`,
      "app         http://127.0.0.1:4400",
      `runtime ws  ws://127.0.0.1:4410 (token: ${join(home, ".wsp", "host-token")})`,
      `state       ${statePath}`,
      `log         ${join(home, ".wsp", "host.log")}`,
      "Stop it with wsp down.",
    ]);
  });

  it("refuses before writing anything when the key is only in this shell, since the service starts without it", async () => {
    vi.stubEnv("SOLARI_API_KEY", KEY);
    const fake = svc();
    const errors: string[] = [];
    expect(await upServiceCommand(quietIO([], errors), opts, fake.deps)).toBe(1);
    expect(errors[0]).toContain(`put it in ${join(home, ".wsp", ".env")} first`);
    expect(fake.ran).toEqual([]);
    expect(keyOnlyInThisShell({ env: { SOLARI_API_KEY: KEY }, cwd: home, home: join(home, ".wsp") })).toBeDefined();
    keyInFile();
    expect(keyOnlyInThisShell({ env: {}, cwd: home, home: join(home, ".wsp") })).toBeUndefined();
  });

  it("keeps a keyless host up: nothing asks for a key, and no line says one went missing", async () => {
    // What wsp init's local road leaves behind: no golden was sealed and this computer is the workspace.
    writeFileSync(statePath, JSON.stringify({ workspaces: { ws_1: LOCAL_RECORD } }));
    const fake = svc();
    const lines: string[] = [];
    const errors: string[] = [];
    expect(await upServiceCommand(quietIO(lines, errors), opts, fake.deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(lines[0]).toBe(`fake service fake.${serviceTag(statePath)} is loaded; it serves again at every login`);
    // A key no shell holds is not a key a service loses: there is none, and this computer is what it serves.
    expect(keyOnlyInThisShell({ env: {}, cwd: home, home: join(home, ".wsp") })).toBeUndefined();
  });

  it("refuses a computer with no service manager, a state file a host already holds, and a state file with no golden", async () => {
    keyInFile();
    const none: string[] = [];
    expect(await upServiceCommand(quietIO([], none), opts, { ...svc().deps, manager: undefined })).toBe(1);
    expect(none[0]).toBe(noManagerLine("fake-os"));

    writeFileSync(join(home, ".wsp", "host.lock"), JSON.stringify({ pid: process.pid, port: 4400, wsPort: 4410, startedAt: new Date().toISOString() }));
    const busy: string[] = [];
    const held = svc();
    expect(await upServiceCommand(quietIO([], busy), opts, held.deps)).toBe(1);
    expect(busy[0]).toContain(`a wsp host (pid ${process.pid}) is already serving ${statePath}`);
    expect(held.ran).toEqual([]);
    rmSync(join(home, ".wsp", "host.lock"));

    writeFileSync(statePath, JSON.stringify({}));
    const bare: string[] = [];
    const empty = svc();
    expect(await upServiceCommand(quietIO([], bare), opts, empty.deps)).toBe(1);
    expect(bare).toEqual([NOTHING_TO_SERVE_LINE]);
    expect(empty.ran).toEqual([]);
  });

  it("a service that loads and never serves points at its log and leaves the service there to look at", async () => {
    keyInFile();
    const fake = svc();
    fake.starts(false);
    writeFileSync(join(home, ".wsp", "host.log"), "Error: EADDRINUSE 4400\n");
    const errors: string[] = [];
    expect(await upServiceCommand(quietIO([], errors), opts, fake.deps)).toBe(1);
    expect(errors[0]).toContain(`nothing answered on port 4400 for ${statePath} within`);
    expect(errors[0]).toContain(join(home, ".wsp", "host.log"));
    expect(errors[1]).toBe("Error: EADDRINUSE 4400");
    expect(existsSync(join(home, "fake-units", `${serviceTag(statePath)}.unit`))).toBe(true);
  });

  it("wsp down stops the service and leaves the state file free", async () => {
    keyInFile();
    const fake = svc();
    expect(await upServiceCommand(quietIO(), opts, fake.deps)).toBe(0);
    const lines: string[] = [];
    expect(await downCommand(quietIO(lines), opts, fake.deps)).toBe(0);
    expect(lines).toEqual([`fake service fake.${serviceTag(statePath)} stopped; nothing serves ${statePath} now`]);
    expect(existsSync(join(home, ".wsp", "host.lock"))).toBe(false);
    expect(existsSync(join(home, "fake-units", `${serviceTag(statePath)}.unit`))).toBe(false);
  });

  it("wsp down with no service says so, and names the pid of a host somebody started by hand", async () => {
    const fake = svc();
    const alone: string[] = [];
    expect(await downCommand(quietIO([], alone), opts, fake.deps)).toBe(1);
    expect(alone[0]).toBe(`wsp down: no fake service for ${statePath}, and no host is serving it.`);

    writeFileSync(join(home, ".wsp", "host.lock"), JSON.stringify({ pid: process.pid, port: 4400, wsPort: 4410, startedAt: new Date().toISOString() }));
    const byHand: string[] = [];
    expect(await downCommand(quietIO([], byHand), opts, fake.deps)).toBe(1);
    expect(byHand[0]).toContain(`the host serving it (pid ${process.pid}) was started by hand`);
    // Both runs still ask the manager: only its answer rules out a service holding on with no file left to name it.
    const asks = ["fake", "holds", `fake.${serviceTag(statePath)}`];
    expect(fake.ran).toEqual([asks, asks]);
  });

  it("wsp status exits 1 while nothing serves the state file and 0 once the service does, saying which ports either way", async () => {
    keyInFile();
    const fake = svc();
    const before: string[] = [];
    expect(await statusCommand(quietIO(before), opts, fake.deps)).toBe(1);
    expect(before).toEqual(["host        not running", `state       ${statePath}`, "service     none; wsp up --service installs a fake service"]);

    expect(await upServiceCommand(quietIO(), opts, fake.deps)).toBe(0);
    const after: string[] = [];
    expect(await statusCommand(quietIO(after), opts, fake.deps)).toBe(0);
    expect(after[0]).toContain(`running (pid ${process.pid}`);
    expect(after.slice(1, 4)).toEqual([
      "app         http://127.0.0.1:4400",
      `runtime ws  ws://127.0.0.1:4410 (token: ${join(home, ".wsp", "host-token")})`,
      `state       ${statePath}`,
    ]);
    expect(after[4]).toBe(`service     fake service fake.${serviceTag(statePath)}, loaded (${join(home, "fake-units", `${serviceTag(statePath)}.unit`)})`);
  });

  it("wsp down stops a service the manager still holds after the unit file went, rather than refusing with the one thing that could stop it gone", async () => {
    keyInFile();
    const fake = svc();
    expect(await upServiceCommand(quietIO(), opts, fake.deps)).toBe(0);
    const name = `fake.${serviceTag(statePath)}`;
    rmSync(join(home, "fake-units", `${serviceTag(statePath)}.unit`));
    fake.ran.length = 0;
    const lines: string[] = [];
    expect(await downCommand(quietIO(lines), opts, fake.deps)).toBe(0);
    expect(fake.ran).toEqual([
      ["fake", "holds", name],
      ["fake", "unload", name],
    ]);
    expect(lines).toEqual([`fake service ${name} stopped; nothing serves ${statePath} now`]);
  });

  it("wsp down changes nothing and names the command that could not answer when the manager cannot say whether it holds it", async () => {
    keyInFile();
    const fake = svc();
    expect(await upServiceCommand(quietIO(), opts, fake.deps)).toBe(0);
    const unitPath = join(home, "fake-units", `${serviceTag(statePath)}.unit`);
    fake.mute();
    fake.ran.length = 0;
    const errors: string[] = [];
    expect(await downCommand(quietIO([], errors), opts, fake.deps)).toBe(1);
    expect(errors[0]).toContain("fake holds could not say");
    expect(errors[0]).toContain(`cannot tell whether the fake service fake.${serviceTag(statePath)} is still loaded`);
    expect(errors[0]).toContain(unitPath);
    expect(fake.ran).toEqual([["fake", "holds", `fake.${serviceTag(statePath)}`]]);
    expect(existsSync(unitPath)).toBe(true);

    rmSync(unitPath);
    const gone: string[] = [];
    expect(await downCommand(quietIO([], gone), opts, fake.deps)).toBe(1);
    expect(gone[0]).toContain("is still loaded. Nothing was changed.");
  });

  it("wsp up --service says it serves once the app answers, not when the lock a host writes before it binds turned up", async () => {
    keyInFile();
    const fake = svc({ answers: () => Promise.resolve(false) });
    writeFileSync(join(home, ".wsp", "host.log"), "Error: EADDRINUSE 4400\n");
    const errors: string[] = [];
    expect(await upServiceCommand(quietIO([], errors), opts, fake.deps)).toBe(1);
    expect(errors[0]).toContain("nothing answered on port 4400");
    expect(errors[0]).toContain(join(home, ".wsp", "host.log"));
    expect(errors[1]).toBe("Error: EADDRINUSE 4400");
  });

  it("wsp status exits 1 while the lock is there and nothing answers on the port it names", async () => {
    keyInFile();
    const fake = svc({ answers: () => Promise.resolve(false) });
    expect(await upServiceCommand(quietIO(), opts, fake.deps)).toBe(1);
    const lines: string[] = [];
    expect(await statusCommand(quietIO(lines), opts, fake.deps)).toBe(1);
    expect(lines[0]).toContain(`host        not answering on port 4400 (pid ${process.pid}`);
  });

  it("says so when the Claude key is only in this shell, since the service starts without it and forks workspaces with no claude credentials", async () => {
    keyInFile();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-only-here");
    const fake = svc();
    const lines: string[] = [];
    expect(await upServiceCommand(quietIO(lines), opts, fake.deps)).toBe(0);
    expect(lines[0]).toContain("ANTHROPIC_API_KEY is only in this shell");
    expect(lines[0]).toContain(join(home, ".wsp", ".env"));
    expect(JSON.stringify(fake.plans[0])).not.toContain("sk-ant-only-here");
    expect(claudeKeyOnlyInThisShell({ env: { ANTHROPIC_API_KEY: "sk-ant-only-here" }, cwd: home, home: join(home, ".wsp") })).toBeDefined();
    writeFileSync(join(home, ".wsp", ".env"), `SOLARI_API_KEY=${KEY}\nANTHROPIC_API_KEY=sk-ant-only-here\n`);
    expect(claudeKeyOnlyInThisShell({ env: { ANTHROPIC_API_KEY: "sk-ant-only-here" }, cwd: home, home: join(home, ".wsp") })).toBeUndefined();
    expect(claudeKeyOnlyInThisShell({ env: {}, cwd: home, home: join(home, ".wsp") })).toBeUndefined();
  });

  it("reads the keys off the sources it was handed, not off whatever .env sits in the folder wsp was run from", async () => {
    const checkout = join(home, "checkout");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, ".env"), `SOLARI_API_KEY=${KEY}\n`);
    vi.spyOn(process, "cwd").mockReturnValue(checkout);
    vi.stubEnv("SOLARI_API_KEY", KEY);
    const fake = svc();
    const errors: string[] = [];
    expect(await upServiceCommand(quietIO([], errors), opts, fake.deps)).toBe(1);
    expect(errors[0]).toContain(`put it in ${join(home, ".wsp", ".env")} first`);
    expect(fake.ran).toEqual([]);
  });
});
