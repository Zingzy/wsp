// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { DAEMON_USAGE, daemonArgv, daemonOptions, parseDaemonArgs, type DaemonArgs } from "../src/args.js";

/** One of every flag, so the round trip below covers the whole list. */
const EVERY: DaemonArgs = {
  host: "127.0.0.1",
  port: 7171,
  tokenPath: "/tmp/tok",
  root: "/srv/work",
  rootsPath: "/srv/work/.wsp/roots",
  kind: "ssh",
  workFolder: "/srv/work/wsp-work",
  inbox: "/srv/inbox",
  inboxQuietMs: 150,
  inboxPollMs: 30,
  manifest: "/srv/.wsp/manifest.json",
  runDir: "/srv/.wsp/run",
  logDir: "/srv/.wsp/logs",
  openSocket: "/srv/.wsp/open.sock",
  portFile: "/srv/.wsp/daemon.port",
  procRoot: "/tmp/fake-proc",
  passwd: "/tmp/passwd",
  portsIntervalMs: 25,
  sysIntervalMs: 20,
  procIntervalMs: 20,
  modeIntervalMs: 50,
  authDeadlineMs: 60,
  placeFile: "/home/maya/.wsp/place.json",
  home: "/home/maya",
  wspArgv: ["/usr/local/bin/node", "/opt/wsp/bin.js"],
  agents: [
    { id: "a1", bin: "agent-one" },
    { id: "b2", bin: "agent-two" },
  ],
  linkConnectMs: 500,
  linkQuietMs: 120,
  linkRefusedRetryMs: 600_000,
  linkBackoffMs: 60_000,
};

describe("wsp-daemon argv", () => {
  it("defaults to the in-guest shape (0.0.0.0:7070) when no flags are given", () => {
    expect(parseDaemonArgs([])).toEqual({});
    expect(daemonOptions({})).toEqual({});
  });

  it("parses --host for local runs, --port, and --token-path", () => {
    expect(parseDaemonArgs(["--host", "127.0.0.1", "--port", "7171"])).toEqual({ host: "127.0.0.1", port: 7171 });
    expect(parseDaemonArgs(["--token-path", "/tmp/tok"])).toEqual({ tokenPath: "/tmp/tok" });
  });

  it("parses --root for a workspace root other than HOME", () => {
    expect(parseDaemonArgs(["--root", "/srv/work"])).toEqual({ root: "/srv/work" });
    expect(() => parseDaemonArgs(["--root"])).toThrow(/--root/);
  });

  it("reads every flag back to the args that wrote it, one word per --wsp-argv", () => {
    const argv = daemonArgv(EVERY);
    expect(argv.filter(w => w === "--wsp-argv")).toHaveLength(2);
    expect(parseDaemonArgs(argv)).toEqual(EVERY);
    // Every flag the usage line names is one the parser takes, and the other way round.
    for (const flag of argv.filter(w => w.startsWith("--"))) expect(DAEMON_USAGE).toContain(flag);
    expect(DAEMON_USAGE.match(/--[a-z-]+/g)).toHaveLength(Object.keys(EVERY).length);
  });

  it("refuses a missing value, a value that is another flag, or a non-numeric number", () => {
    expect(() => parseDaemonArgs(["--host"])).toThrow(/--host/);
    expect(() => parseDaemonArgs(["--host", "--port", "1"])).toThrow(/--host/);
    expect(() => parseDaemonArgs(["--port", "abc"])).toThrow(/--port/);
    expect(() => parseDaemonArgs(["--sys-interval-ms", "2.5"])).toThrow(/--sys-interval-ms/);
    expect(() => parseDaemonArgs(["--token-path"])).toThrow(/--token-path/);
    expect(() => parseDaemonArgs(["--wat"])).toThrow(/--wat/);
  });

  it("reads --agents as id=command pairs and refuses a pair with either half missing", () => {
    expect(parseDaemonArgs(["--agents", "a1=agent-one,b2=/opt/b/bin"])).toEqual({ agents: [{ id: "a1", bin: "agent-one" }, { id: "b2", bin: "/opt/b/bin" }] });
    expect(daemonArgv({ agents: [{ id: "a1", bin: "agent-one" }] })).toEqual(["--agents", "a1=agent-one"]);
    expect(() => parseDaemonArgs(["--agents", "a1"])).toThrow(/--agents/);
    expect(() => parseDaemonArgs(["--agents", "=x"])).toThrow(/--agents/);
    expect(() => parseDaemonArgs(["--agents", "a1="])).toThrow(/--agents/);
  });

  it("takes any word for --kind, since the daemon refuses a kind it lacks at the watch in the pane's words", () => {
    expect(parseDaemonArgs(["--kind", "plan9"])).toEqual({ kind: "plan9" });
  });
});

describe("the flags as the options the daemon starts with", () => {
  it("names each option after its flag, and puts the three manifest flags under one manifest", () => {
    const opts = daemonOptions(EVERY);
    expect(opts).toMatchObject({
      host: "127.0.0.1",
      port: 7171,
      tokenPath: "/tmp/tok",
      root: "/srv/work",
      rootsPath: "/srv/work/.wsp/roots",
      kind: "ssh",
      workFolder: "/srv/work/wsp-work",
      inboxDir: "/srv/inbox",
      inboxQuietMs: 150,
      inboxPollMs: 30,
      manifest: { path: "/srv/.wsp/manifest.json", runDir: "/srv/.wsp/run", logDir: "/srv/.wsp/logs" },
      openSocketPath: "/srv/.wsp/open.sock",
      portFile: "/srv/.wsp/daemon.port",
      procRoot: "/tmp/fake-proc",
      procPasswdPath: "/tmp/passwd",
      portsIntervalMs: 25,
      sysIntervalMs: 20,
      procIntervalMs: 20,
      modeIntervalMs: 50,
      authDeadlineMs: 60,
    });
    expect(daemonOptions({ runDir: "/r" }).manifest).toEqual({ runDir: "/r" });
    // An option left out is left out, not set to nothing.
    expect(Object.values(daemonOptions({ port: 1 })).every(v => v !== undefined)).toBe(true);
  });

  it("turns the link on with a place file, with its timings under their own names and the home the sweep takes", () => {
    const opts = daemonOptions(EVERY, { log: () => {}, exit: () => {} });
    expect(opts.link).toMatchObject({ file: "/home/maya/.wsp/place.json", connectTimeoutMs: 500, quietMs: 120, refusedRetryMs: 600_000 });
    expect(opts.link?.backoffMs?.(3)).toBe(60_000);
    expect(typeof opts.link?.report).toBe("function");
    expect(typeof opts.link?.onLeave).toBe("function");
    expect(typeof opts.link?.exit).toBe("function");
    expect(typeof opts.log).toBe("function");
    // No place file, no link, whatever else was said about one.
    expect(daemonOptions({ home: homedir(), linkQuietMs: 5 }).link).toBeUndefined();
  });
});
