// SPDX-License-Identifier: AGPL-3.0-only
// What wsp status answers on a computer joined to somebody else's wsp, where
// there is no host and never will be: the place file beside the daemon, the
// daemon's own readings off its loopback port, and the rows a person reads
// from them. The daemon here is a fake link, so the case is the road and the
// words, not a binary.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtUptime, placeDaemonPaths, type DaemonEvent, type PlaceFile, type ProcEntry } from "@wsp/protocol";
import type { DaemonReach } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statusCommand, type CliIO, type ServiceDeps } from "../src/cli.js";
import { hereAnswering, hereLines, openHere, readHere, type HereDeps, type HereReading } from "../src/place-here.js";
import type { WatchSignals } from "../src/watch.js";
import { writePlaceFile } from "../src/place-report.js";
import { writeHost } from "../src/hosts.js";
import { captured } from "./verbs-fixture.js";

const PLACE: PlaceFile = {
  placeId: "p_spoo",
  name: "spoo",
  hostName: "zingzy-mac",
  hostUrls: ["ws://192.168.1.20:4410"],
  hostPublicKey: "k",
  keyPath: "/nowhere/place-key.pem",
  joinedAt: "2026-09-13T02:00:00.000Z",
  awake: false,
};

const PROC = (over: Partial<ProcEntry>): ProcEntry => ({ pid: 1, ppid: 0, user: "root", state: "S", comm: "init", cmdline: "/sbin/init", cpu: 0, rss: 1024, startedAt: 0, ...over });

/** A daemon on the other end of one link: it answers both watches when the link says it is live, and `push` sends
 * whatever samples that connect is to carry. `watches` counts the ops asked for, so a reconnect that failed to ask
 * again would be a number here rather than a quiet screen. `refuse` rejects the dial; `quiet` is the worse case, a
 * port nothing listens on, where the reach redials for as long as it is held and `ready` never settles at all. */
function fakeDaemon(
  push: (send: (e: DaemonEvent) => void) => void,
  opts: { refuse?: string; quiet?: boolean } = {},
): { deps: HereDeps; dialled: { port: number; token: string }[]; closed: number; watches: string[]; turn: (live: boolean) => void } {
  const dialled: { port: number; token: string }[] = [];
  const watches: string[] = [];
  const state = { closed: 0 };
  let status: ((live: boolean) => void) | undefined;
  const deps: HereDeps = {
    answerMs: 50,
    dial: (port, token, onEvent, onLive) => {
      dialled.push({ port, token });
      status = onLive;
      const reach: DaemonReach = {
        ready: opts.quiet === true ? new Promise<void>(() => {}) : opts.refuse === undefined ? Promise.resolve() : Promise.reject(new Error(opts.refuse)),
        request: async op => {
          watches.push(op);
          // Both watches are asked for together; the samples follow the second, as a daemon's first tick does.
          if (op === "proc.watch") queueMicrotask(() => push(onEvent));
          return {};
        },
        status: () => "live",
        stats: () => ({ pingsSent: 0, pongsReceived: 0, reconnects: 0 }),
        close: () => {
          state.closed++;
        },
      };
      reach.ready.catch(() => {});
      if (opts.refuse === undefined && opts.quiet !== true) queueMicrotask(() => onLive(true));
      return reach;
    },
  };
  return {
    deps,
    dialled,
    watches,
    turn: live => status?.(live),
    get closed() {
      return state.closed;
    },
  };
}

const READINGS = (send: (e: DaemonEvent) => void): void => {
  send({ type: "sys.sample", cpu: 12.4, load1: 0.84, mem: { used: 5_368_709_120, total: 8_589_934_592 }, disk: { used: 23_622_320_128, total: 80_530_636_800 }, at: 1 });
  send({
    type: "proc.snapshot",
    at: 1,
    daemon: 900,
    total: 43,
    procs: [PROC({ pid: 12, comm: "node", cmdline: "node /root/.local/bin/wsp mcp", cpu: 38.2, rss: 412 * 1024 * 1024, startedAt: 0 }), PROC({ pid: 900, comm: "wsp-daemon", cmdline: "wsp-daemon --kind place", cpu: 1.5, rss: 9 * 1024 * 1024, startedAt: 0 })],
  });
};

describe("wsp status on a computer joined as a place", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-here-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const joined = (port = "41234", token = "tok"): void => {
    const at = placeDaemonPaths(home);
    writePlaceFile(at.placeFile, PLACE);
    writeFileSync(at.portFile, `${port}\n`);
    writeFileSync(at.tokenPath, `${token}\n`);
  };

  it("reads nothing on a computer that belongs to no wsp, so the line answers for the host here as it always did", async () => {
    expect(await readHere(home, fakeDaemon(READINGS).deps)).toBeUndefined();
  });

  it("dials the daemon on the port and token beside the place file, takes one reading of each watch, and closes the socket", async () => {
    joined();
    const daemon = fakeDaemon(READINGS);
    const reading = await readHere(home, daemon.deps);
    expect(daemon.dialled).toEqual([{ port: 41234, token: "tok" }]);
    expect(daemon.watches).toEqual(["sys.watch", "proc.watch"]);
    expect(daemon.closed).toBe(1);
    expect(reading?.place.name).toBe("spoo");
    expect(reading?.sys?.load1).toBe(0.84);
    expect(reading?.procs?.total).toBe(43);
    expect(hereAnswering(reading!)).toBe(true);
  });

  it("holds one link for the whole watch: a daemon that pushes twice is read twice on one dial, and next settles on each push", async () => {
    joined();
    // The daemon's first tick, then a second sample a moment later, as the sampler's next interval gives it.
    let send: ((e: DaemonEvent) => void) | undefined;
    const daemon = fakeDaemon(out => {
      send = out;
      READINGS(out);
    });
    const held = (await openHere(home, daemon.deps))!;
    try {
      expect(daemon.dialled).toHaveLength(1);
      expect(held.reading().sys?.cpu).toBe(12.4);
      const pushed = held.next();
      send!({ type: "sys.sample", cpu: 71.5, load1: 3.2, mem: { used: 7_000_000_000, total: 8_589_934_592 }, disk: { used: 23_622_320_128, total: 80_530_636_800 }, at: 2 });
      await pushed;
      // One dial, two readings: the socket was never closed and reopened between them.
      expect(daemon.dialled).toHaveLength(1);
      expect(daemon.closed).toBe(0);
      expect(held.reading().sys?.cpu).toBe(71.5);
    } finally {
      held.close();
    }
    expect(daemon.closed).toBe(1);
  });

  it("asks for both watches again on every connect the link makes, so a reconnect does not leave it open and quiet", async () => {
    joined();
    const daemon = fakeDaemon(READINGS);
    const held = (await openHere(home, daemon.deps))!;
    try {
      expect(daemon.watches).toEqual(["sys.watch", "proc.watch"]);
      // The link dropped and came back: the reach re-authenticates, and the watches are this caller's to ask again.
      daemon.turn(true);
      await new Promise(r => setTimeout(r, 5));
      expect(daemon.watches).toEqual(["sys.watch", "proc.watch", "sys.watch", "proc.watch"]);
    } finally {
      held.close();
    }
  });

  it("does not hang on a port nothing listens on: the wait is bounded and the row says what it found, with the log named", async () => {
    joined("7788");
    // A port file a daemon that died left behind. The reach redials a refused connect for as long as it is held, so
    // ready never settles; without a bound this line would print nothing and never exit.
    const daemon = fakeDaemon(READINGS, { quiet: true });
    const io = captured();
    const started = Date.now();
    expect(await statusCommand(io, { statePath: join(home, "state.json"), home }, deps(daemon.deps))).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(io.lines).toEqual(["place       spoo, joined to zingzy-mac", `wsp         not answering on port 7788: nothing answered in 50ms; its log is ${placeDaemonPaths(home).placeLog}`]);
    // The link it opened to find that out is closed behind it.
    expect(daemon.closed).toBe(1);
  });

  it("a daemon that goes away mid-watch stops the row saying it answers, and the figures stop at the moment it went", async () => {
    joined();
    const daemon = fakeDaemon(READINGS);
    const clock = { at: 1_000_000 };
    const held = (await openHere(home, daemon.deps, () => clock.at))!;
    try {
      expect(hereAnswering(held.reading())).toBe(true);
      // The daemon is terminated for good: the reach drops to connecting and redials, and nothing pushes again.
      const redrawn = held.next();
      clock.at += 3_000;
      daemon.turn(false);
      // The frame is woken at once rather than on the next tick, so the screen never says answering for a daemon
      // that is gone for longer than it takes to draw.
      await redrawn;
      const dropped = held.reading();
      expect(hereAnswering(dropped)).toBe(false);
      expect(dropped.droppedAt).toBe(1_003_000);
      const lines = hereLines(dropped, 1_603_000);
      expect(lines[1]).toBe(`wsp         stopped answering on port 41234 10m ago; its log is ${placeDaemonPaths(home).placeLog}`);
      // The UP column counts to the drop and not to now: a reading nothing sent is not one this line invents.
      expect(lines[7]).toContain(fmtUptime(1_003_000));
      expect(lines[7]).not.toContain(fmtUptime(1_603_000));

      // It comes back: the hook re-asks for the watches and the row answers again on the next sample.
      daemon.turn(true);
      await new Promise(r => setTimeout(r, 5));
      expect(daemon.watches).toEqual(["sys.watch", "proc.watch", "sys.watch", "proc.watch"]);
      expect(hereAnswering(held.reading())).toBe(true);
    } finally {
      held.close();
    }
  });

  it("prints which wsp the computer belongs to, what it is doing and the busiest processes, and exits 0", async () => {
    joined();
    const io = captured();
    expect(await statusCommand(io, { statePath: join(home, "state.json"), home }, deps(fakeDaemon(READINGS).deps))).toBe(0);
    expect(io.lines.slice(0, 5)).toEqual([
      "place       spoo, joined to zingzy-mac",
      "wsp         answering on port 41234",
      "cpu         12% busy, load 0.84",
      "memory      5 GB of 8 GB",
      "disk        22 GB of 75 GB",
    ]);
    expect(io.lines[5]).toBe("processes   43 on this computer, busiest first:");
    // Busiest first, whatever order the snapshot arrived in, and the command is the whole of what started it.
    expect(io.lines[6]).toMatch(/^ {12}PID\s+USER\s+CPU\s+MEMORY\s+UP\s+COMMAND$/);
    expect(io.lines[7]).toContain("node /root/.local/bin/wsp mcp");
    expect(io.lines[8]).toContain("wsp-daemon --kind place");
  });

  it("says the daemon never came up when it wrote no port, and exits 1 with the road back named", async () => {
    const at = placeDaemonPaths(home);
    writePlaceFile(at.placeFile, PLACE);
    const io = captured();
    expect(await statusCommand(io, { statePath: join(home, "state.json"), home }, deps(fakeDaemon(READINGS).deps))).toBe(1);
    expect(io.lines).toEqual(["place       spoo, joined to zingzy-mac", `wsp         nothing has come up on this computer since it joined; its log is ${placeDaemonPaths(home).placeLog}`]);
  });

  it("says what the daemon refused on its port rather than hanging on it, and exits 1", async () => {
    joined("7788");
    const io = captured();
    expect(await statusCommand(io, { statePath: join(home, "state.json"), home }, deps(fakeDaemon(READINGS, { refuse: "daemon token refused; the host holds the current one" }).deps))).toBe(1);
    expect(io.lines).toEqual(["place       spoo, joined to zingzy-mac", `wsp         not answering on port 7788: daemon token refused; the host holds the current one; its log is ${placeDaemonPaths(home).placeLog}`]);
  });

  it("--watch redraws the rows where they stand, and off a terminal is refused in two halves", async () => {
    joined();
    const frames: string[] = [];
    const io: CliIO = { ...captured(), redraw: { write: text => void frames.push(text), columns: () => 100 } };
    const daemon = fakeDaemon(READINGS);
    const at = { statePath: join(home, "state.json"), home, watch: true };
    // Ctrl-C, without a real signal: one would take the test runner with it.
    const held = new Set<() => void>();
    const signals: WatchSignals = {
      on: (_s, l) => {
        held.add(l);
        return undefined;
      },
      off: (_s, l) => held.delete(l),
    };
    const watching = statusCommand(io, at, { ...deps(daemon.deps), signals });
    await new Promise(r => setTimeout(r, 30));
    for (const stop of [...held]) stop();
    expect(await watching).toBe(0);
    expect(frames[0]).toBe("\x1b[?25l");
    expect(frames.at(-1)).toBe("\x1b[?25h");
    expect(frames.some(f => f.includes("place       spoo, joined to zingzy-mac"))).toBe(true);
    // One dial for the whole of it, and the link closed when the rows stopped.
    expect(daemon.dialled).toHaveLength(1);
    expect(daemon.closed).toBe(1);

    const noTerminal = captured();
    const quiet = fakeDaemon(READINGS);
    await expect(statusCommand(noTerminal, at, { ...deps(quiet.deps), signals })).rejects.toThrow("wsp status --watch redraws where it stands");
    // The refusal is read before the dial: a line with nowhere to redraw opens no link to the daemon to say so.
    expect(quiet.dialled).toEqual([]);
  });

  it("a watch with nothing to hold opens again every frame, so an agent coming up after a join is seen without restarting it", async () => {
    // Joined, and the agent has not written its port yet: there is nothing to dial and nothing to wait on.
    const at = placeDaemonPaths(home);
    writePlaceFile(at.placeFile, PLACE);
    const frames: string[] = [];
    const io: CliIO = { ...captured(), redraw: { write: text => void frames.push(text), columns: () => 100 } };
    const daemon = fakeDaemon(READINGS);
    const stops = new Set<() => void>();
    const signals: WatchSignals = {
      on: (_s, l) => {
        stops.add(l);
        return undefined;
      },
      off: (_s, l) => stops.delete(l),
    };
    const watching = statusCommand(io, { statePath: join(home, "state.json"), home, watch: true }, { ...deps(daemon.deps), signals });
    await vi.waitFor(() => expect(frames.some(f => f.includes("nothing has come up on this computer since it joined"))).toBe(true));
    expect(daemon.dialled).toEqual([]);

    // The agent comes up under its service manager and writes its port; the watch finds it without being restarted.
    writeFileSync(at.portFile, "41234\n");
    writeFileSync(at.tokenPath, "tok\n");
    await vi.waitFor(() => expect(frames.some(f => f.includes("answering on port 41234"))).toBe(true), { timeout: 5_000 });
    for (const stop of [...stops]) stop();
    expect(await watching).toBe(0);
    expect(daemon.dialled).toEqual([{ port: 41234, token: "tok" }]);
    expect(daemon.closed).toBe(1);
  });

  it("refuses --watch where it would follow nothing: a computer in no wsp, and a line aimed at a host over there", async () => {
    const io: CliIO = { ...captured(), redraw: { write: () => {}, columns: () => 100 } };
    const at = { statePath: join(home, "state.json"), home, watch: true };
    // This computer is in no wsp: the rows would be about the host serving here, which a watch does not follow.
    await expect(statusCommand(io, at, deps(fakeDaemon(READINGS).deps))).rejects.toThrow(
      "wsp status --watch reads the agent on a computer joined to somebody's wsp, and this computer is joined to none. Run wsp status without --watch for the host serving here, or wsp workspaces --watch to follow what it runs.",
    );
    joined();
    writeHost(home, "box", { url: "http://box.example:4400", deviceId: "d1", deviceToken: "t1", pairedAt: "2026-09-13T02:00:00.000Z" });
    await expect(statusCommand(io, { ...at, host: "box" }, deps(fakeDaemon(READINGS).deps))).rejects.toThrow("wsp status --watch reads the agent on the computer you are sitting at, and this line is aimed at the host on box.");
  });

  it("hereLines says nothing about a host on a computer that has none, since one would only ever read not running", () => {
    const reading: HereReading = { place: PLACE, port: 41234, logPath: "/root/.wsp/place.log" };
    expect(hereLines(reading).join("\n")).not.toContain("host");
  });
});

/** The service deps a status line reads, with this computer's own reading handed in and everything else refusing:
 * a joined computer answers off its place file alone and dials no host. */
function deps(here: HereDeps): ServiceDeps {
  return {
    platform: "linux",
    manager: undefined,
    run: () => Promise.resolve({ code: 1, output: "" }),
    waitMs: 0,
    keys: { env: {}, cwd: tmpdir(), home: tmpdir() },
    answers: () => Promise.resolve(false),
    dial: () => Promise.reject(new Error("a joined computer dials no host from this line")),
    stop: () => {},
    here: home => openHere(home, here),
  };
}
