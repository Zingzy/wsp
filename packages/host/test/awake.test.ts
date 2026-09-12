// SPDX-License-Identifier: AGPL-3.0-only
// Holding a joined computer out of idle sleep: which tool each platform's
// keeper runs, that the hold is a child whose pid is the only one killed, and
// that the agent reads the place file for it and follows the file's changes.
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AWAKE_KEEPERS, awakeKeeperFor, holdWhileJoined, noKeeperLine, type AwakeKeeper } from "../src/awake.js";
import { placeFilePath, placeKeyPath, writePlaceFile } from "../src/place-report.js";
import { writePlaceAwake } from "../src/places.js";

/** A spawn that records what it was asked to run and hands back a child with a pid nothing else has. */
function fakeSpawn(): { spawn: typeof nodeSpawn; ran: { file: string; args: readonly string[] }[]; pid: number } {
  const ran: { file: string; args: readonly string[] }[] = [];
  const pid = 987_654;
  const spawn = ((file: string, args: readonly string[]) => {
    ran.push({ file, args: [...args] });
    return { pid, unref: () => {} } as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;
  return { spawn, ran, pid };
}

describe("the keeper for each computer", () => {
  it("runs caffeinate on a Mac watching the pid it is held for, and lets go by killing that child's own pid and no other", () => {
    const fake = fakeSpawn();
    const killed: number[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number) => void killed.push(pid)) as never);
    try {
      const hold = AWAKE_KEEPERS.darwin.hold("running threads for another wsp", fake.spawn, 4242);
      expect(fake.ran).toEqual([{ file: "caffeinate", args: ["-i", "-s", "-w", "4242"] }]);
      hold.release();
      // Twice is once: a release that ran already must not kill a pid the system has handed to somebody else.
      hold.release();
      expect(killed).toEqual([fake.pid]);
    } finally {
      kill.mockRestore();
    }
  });

  it("runs systemd-inhibit on Linux over a command that ends with the pid it is held for, carrying the reason its listing shows", () => {
    const fake = fakeSpawn();
    AWAKE_KEEPERS.linux.hold("running threads for another wsp", fake.spawn, 4242);
    expect(fake.ran[0]!.file).toBe("systemd-inhibit");
    expect(fake.ran[0]!.args).toContain("--why=running threads for another wsp");
    expect(fake.ran[0]!.args).toContain("--what=idle:sleep");
    expect(fake.ran[0]!.args.slice(-3)).toEqual(["--pid=4242", "-f", "/dev/null"]);
  });

  it("watches this process by default, so an agent that dies without releasing takes the hold with it", () => {
    for (const held of [AWAKE_KEEPERS.darwin, AWAKE_KEEPERS.linux]) {
      const fake = fakeSpawn();
      held.hold("running threads for another wsp", fake.spawn);
      expect(fake.ran[0]!.args.join(" ")).toContain(String(process.pid));
    }
  });

  it("knows no way to hold anything else awake, and says so in words rather than pretending", () => {
    expect(awakeKeeperFor("darwin")).toBe(AWAKE_KEEPERS.darwin);
    expect(awakeKeeperFor("linux")).toBe(AWAKE_KEEPERS.linux);
    expect(awakeKeeperFor("win32")).toBeUndefined();
    expect(noKeeperLine("win32")).toContain("win32");
  });
});

describe("the hold the agent keeps while this computer is joined", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A keeper that holds nothing, so the test can read whether a hold stands without a tool this box may not have. */
  const counted = (): { keeper: AwakeKeeper; holds: number; releases: number } => {
    const state = { holds: 0, releases: 0, keeper: undefined as unknown as AwakeKeeper };
    state.keeper = { words: "a fake", argv: () => ["a-fake"], hold: () => ((state.holds += 1), { release: () => void (state.releases += 1) }) };
    return state as { keeper: AwakeKeeper; holds: number; releases: number };
  };

  const placeFile = (home: string, awake: boolean): string => {
    const path = placeFilePath(home);
    writePlaceFile(path, { placeId: "p_1", name: "old-macbook", hostName: "zingzy-mbp", hostUrls: ["http://192.168.1.20:4420"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString(), awake });
    return path;
  };

  const tmp = (name: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `wsp-${name}-`));
    dirs.push(dir);
    return dir;
  };

  it("takes it at start when the file asks for it, lets go when the file flips, and takes it again when it flips back", async () => {
    const home = tmp("awake-watch");
    const file = placeFile(home, true);
    const keeper = counted();
    const lines: string[] = [];
    const watch = holdWhileJoined({ file, keeper: keeper.keeper, log: line => lines.push(line), intervalMs: 20 });
    try {
      expect(watch.held()).toBe(true);
      expect(lines[0]).toContain("a fake");
      writePlaceAwake(home, false);
      await vi.waitFor(() => expect(watch.held()).toBe(false), { timeout: 3_000 });
      expect(keeper.releases).toBe(1);
      writePlaceAwake(home, true);
      await vi.waitFor(() => expect(watch.held()).toBe(true), { timeout: 3_000 });
      expect(keeper.holds).toBe(2);
    } finally {
      watch.stop();
    }
  });

  it("holds nothing while the file does not ask, and lets go once for a stop however it came", () => {
    const home = tmp("awake-off");
    const keeper = counted();
    const off = holdWhileJoined({ file: placeFile(home, false), keeper: keeper.keeper, intervalMs: 20 });
    expect(off.held()).toBe(false);
    off.stop();
    expect(keeper.holds).toBe(0);
    const on = holdWhileJoined({ file: placeFile(tmp("awake-stop"), true), keeper: keeper.keeper, intervalMs: 20 });
    on.stop();
    on.stop();
    expect(keeper.releases).toBe(1);
  });

  it("says once that it can hold nothing on a computer wsp knows no way to hold, and holds nothing", () => {
    const lines: string[] = [];
    const watch = holdWhileJoined({ file: placeFile(tmp("awake-nokeeper"), true), keeper: undefined, log: line => lines.push(line), intervalMs: 20 });
    expect(watch.held()).toBe(false);
    expect(lines.join("\n")).toContain("sleeps on its own schedule");
    watch.stop();
  });
});
