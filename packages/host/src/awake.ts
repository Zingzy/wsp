// SPDX-License-Identifier: AGPL-3.0-only
// Holding a computer out of idle sleep while it runs threads for somebody
// else's wsp. One module per platform, picked by name, so the rest of wsp
// asks for a hold and never asks which computer it is on: this is the one
// switch on the platform for it.
//
// The hold is a child process rather than a flag anywhere, and each tool is
// told to watch the agent's own pid: an agent that is killed or crashes takes
// the hold with it rather than leaving an assertion nobody can find, since
// nothing would be left running to let it go.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { unwatchFile, watchFile } from "node:fs";
import { platform } from "node:os";
import { readPlaceFile } from "./place-report.js";

/** A hold on the computer's sleep, until it is let go. */
export interface AwakeHold {
  release(): void;
}

export interface AwakeKeeper {
  /** What the person reads in the log line: the tool doing the holding. */
  words: string;
  /** The line this computer holds itself awake with, watching the pid it is held for. */
  argv(why: string, watching: number): readonly string[];
  /** Holds the computer out of idle sleep until released. The child's pid is recorded and only that pid is killed,
   * and the child itself ends when `watching` does, so a process that dies without releasing frees the hold. */
  hold(why: string, spawn?: typeof nodeSpawn, watching?: number): AwakeHold;
}

/** One child, its pid remembered, killed once and only once. */
function holder(argv: readonly string[], spawn: typeof nodeSpawn): AwakeHold {
  const args = argv.slice(1);
  const child: ChildProcess = spawn(argv[0]!, args, { stdio: "ignore", detached: false });
  child.unref?.();
  let held = true;
  return {
    release: () => {
      if (!held) return;
      held = false;
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          process.kill(pid);
        } catch {
          // Already gone: the tool ended on its own, or the computer took it with a session.
        }
      }
    },
  };
}

/** The keeper for each computer wsp runs a place agent on.
 *
 * `caffeinate -i -s` holds a Mac out of idle sleep and out of system sleep while it is on power; a closed lid still
 * sleeps, which is why the row that turns this on says while the lid is open and it is plugged in. `-w` gives it
 * the pid to watch, and it exits when that pid does.
 *
 * `systemd-inhibit` holds only while the command it runs runs, and `tail --pid` is a command that ends exactly when
 * the pid it was given ends, which is the same watch spelled in the tools Linux has. */
const caffeinate = (_why: string, watching: number): readonly string[] => ["caffeinate", "-i", "-s", "-w", String(watching)];
const inhibit = (why: string, watching: number): readonly string[] => [
  "systemd-inhibit",
  "--what=idle:sleep",
  "--who=wsp",
  `--why=${why}`,
  "--mode=block",
  "tail",
  `--pid=${watching}`,
  "-f",
  "/dev/null",
];

/** One keeper out of the line it runs, so the tool a computer holds itself awake with is written once. */
const keeper = (words: string, argv: (why: string, watching: number) => readonly string[]): AwakeKeeper => ({
  words,
  argv,
  hold: (why, spawn = nodeSpawn, watching = process.pid) => holder(argv(why, watching), spawn),
});

export const AWAKE_KEEPERS: { readonly darwin: AwakeKeeper; readonly linux: AwakeKeeper } = {
  darwin: keeper("caffeinate", caffeinate),
  linux: keeper("systemd-inhibit", inhibit),
};

/** The keeper for a platform, or nothing where wsp knows no way to hold one awake. */
export function awakeKeeperFor(platform: string): AwakeKeeper | undefined {
  return platform === "darwin" ? AWAKE_KEEPERS.darwin : platform === "linux" ? AWAKE_KEEPERS.linux : undefined;
}

/** The line said on a computer wsp cannot hold awake, so the toggle never reads as done when nothing happened. */
export const noKeeperLine = (platform: string): string => `nothing on ${platform} holds this computer awake for wsp; it sleeps on its own schedule while it is joined`;

/** What the log says when the hold is taken and let go, so a person reading the agent's log can see both. */
export const awakeHeldLine = (words: string): string => `holding this computer out of idle sleep with ${words} while it is joined`;
export const awakeFreedLine = (words: string): string => `let this computer sleep again; the ${words} hold is gone`;

/** How often the place file is read again for the toggle. Two seconds: the person pressed a switch and is watching
 * the row, and nothing else on this computer is waiting on it. */
const WATCH_EVERY_MS = 2_000;

export interface AwakeWatch {
  /** Lets the hold go and stops reading the file; the agent's own exit and a leave both come through here. */
  stop(): void;
  /** Whether a hold stands right now. */
  held(): boolean;
}

/** The hold this computer's place file asks for, taken at once and taken or let go whenever that file changes. It
 * lives in the agent rather than the app so that quitting the app changes nothing about a computer's sleep. */
export function holdWhileJoined(opts: { file: string; keeper?: AwakeKeeper | undefined; log?: (line: string) => void; intervalMs?: number }): AwakeWatch {
  const log = opts.log ?? ((): void => {});
  const keeper = "keeper" in opts ? opts.keeper : awakeKeeperFor(platform());
  let hold: AwakeHold | undefined;
  let said = false;
  const settle = (): void => {
    const want = readPlaceFile(opts.file)?.awake === true;
    if (want && hold === undefined) {
      if (keeper === undefined) {
        if (!said) log(noKeeperLine(platform()));
        said = true;
        return;
      }
      hold = keeper.hold("running threads for another wsp");
      log(awakeHeldLine(keeper.words));
      return;
    }
    if (!want && hold !== undefined) {
      hold.release();
      hold = undefined;
      if (keeper !== undefined) log(awakeFreedLine(keeper.words));
    }
  };
  settle();
  watchFile(opts.file, { interval: opts.intervalMs ?? WATCH_EVERY_MS }, settle);
  return {
    held: () => hold !== undefined,
    stop: () => {
      unwatchFile(opts.file, settle);
      hold?.release();
      hold = undefined;
    },
  };
}
