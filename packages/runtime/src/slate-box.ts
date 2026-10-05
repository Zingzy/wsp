// SPDX-License-Identifier: AGPL-3.0-only
// A slate's command on the thread's own machine (07-runs, "on"): a box, a cloud machine, or a workspace on a computer
// somebody owns, all through the engine's Machine, the road a turn there runs on. Before each command the slate's
// files are written to its folder there and the command's values go up beside them base64, in a folder of the run's
// own only its account reads; a fixed launcher decodes them, deletes them before the command starts, and runs the agent's text as
// bash -c's one argument with the values as its environment, positional parameters and stdin, never in its text.
// The machine runs it detached (a nap stalls the reading, not the command), streams its lines, and kills its group at
// the deadline or on a cancel. Its output comes back here and is scrubbed here, as a run on this computer's is.
import { randomBytes } from "node:crypto";
import { DEADLINE_EXIT, putFiles, type Machine } from "@wsp/engine";
import { EXEC_OUTPUT_MAX, shellQuote } from "@wsp/protocol";
import { reshapeAnswer, type Reshape, type RoadEnd, type RunRoad } from "./slate-runs.js";

/** Where a thread's slate keeps its files on its machine: rewritten from the record before every command and
 * removed with the thread, so losing it costs nothing. */
export const BOX_SLATES = "/tmp/wsp-slates";

export const boxSlateDir = (threadId: string): string => `${BOX_SLATES}/${threadId}`;

/** How long a removal a box did not answer waits before it is tried again. */
const OWED_RETRY_MS = 60_000;

/** What this host still has on its boxes: the values of runs in flight, which no sweep may take, and removals a box
 * never answered, tried again on a timer and at every contact with that box until it does. */
export interface BoxLedger {
  live: Set<string>;
  /** Removes a path there, answering whether the box said it is gone; until it does, the removal is owed. */
  remove(machine: Machine, path: string): Promise<boolean>;
  owed(machine: Machine): string[];
  /** The box answered for these removals at a contact of its own. */
  paid(machine: Machine, paths: readonly string[]): void;
  close(): void;
}

export function boxLedger(retryMs = OWED_RETRY_MS): BoxLedger {
  const live = new Set<string>();
  const owed = new Map<string, { machine: Machine; paths: Set<string>; timer?: ReturnType<typeof setTimeout> }>();
  let closed = false;
  const paid = (machine: Machine, paths: readonly string[]): void => {
    const o = owed.get(machine.id);
    if (o === undefined) return;
    for (const path of paths) o.paths.delete(path);
    if (o.paths.size > 0) return;
    if (o.timer !== undefined) clearTimeout(o.timer);
    owed.delete(machine.id);
  };
  const remove = async (machine: Machine, path: string): Promise<boolean> => {
    const gone = await machine.exec(`rm -rf ${shellQuote(path)}`).then(
      r => r.exitCode === 0,
      () => false,
    );
    if (gone) {
      paid(machine, [path]);
      return true;
    }
    const o = owed.get(machine.id) ?? { machine, paths: new Set<string>() };
    o.paths.add(path);
    owed.set(machine.id, o);
    if (o.timer === undefined && !closed) {
      o.timer = setTimeout(() => {
        delete o.timer;
        for (const p of [...o.paths]) void remove(o.machine, p);
      }, retryMs);
      o.timer.unref();
    }
    return false;
  };
  return {
    live,
    remove,
    owed: machine => [...(owed.get(machine.id)?.paths ?? [])],
    paid,
    close() {
      closed = true;
      for (const o of owed.values()) if (o.timer !== undefined) clearTimeout(o.timer);
    },
  };
}

/** Items each ended by a NUL byte, base64: what a value may hold reaches the launcher whole, newlines and all. */
const nulSeparated = (items: readonly string[]): string => Buffer.from(items.map(item => `${item}\0`).join(""), "utf8").toString("base64");

/** The script the machine runs for one command. `payload` is the folder the values went up in. */
export function boxLauncher(o: { payload: string; cwd: string; cmd: string }): string {
  return [
    "set -u",
    `p=${shellQuote(o.payload)}`,
    `base64 -d < "$p/env" > "$p/env0" && base64 -d < "$p/args" > "$p/args0" && base64 -d < "$p/in" > "$p/in0" || { rm -rf "$p"; echo "the run's values did not arrive" >&2; exit 1; }`,
    `while IFS= read -r -d '' k && IFS= read -r -d '' v; do export "$k=$v"; done < "$p/env0"`,
    `a=(); while IFS= read -r -d '' x; do a+=("$x"); done < "$p/args0"`,
    `exec 3< "$p/in0"`,
    `rm -rf "$p"`,
    `cd ${shellQuote(o.cwd)} 2>/dev/null || { echo ${shellQuote(`the folder ${o.cwd} does not exist`)} >&2; exit 1; }`,
    `exec bash -c ${shellQuote(o.cmd)} bash \${a[@]+"\${a[@]}"} <&3`,
  ].join("\n");
}

/** The thread's machine as the road its slate's commands run on. `files` reads the slate's files as they are now;
 * `ready` wakes the machine where it naps, before anything goes up. */
export function boxRoad(machine: Machine, threadId: string, files: () => Readonly<Record<string, string>>, ready: () => Promise<void> = async () => {}, ledger: BoxLedger = boxLedger()): RunRoad {
  const dir = boxSlateDir(threadId);
  const road: RunRoad = {
    slateDir: dir,
    start(o, on) {
      const cancel = new AbortController();
      const payload = `${dir}/.run-${randomBytes(6).toString("hex")}`;
      ledger.live.add(payload);
      void (async () => {
        let end: RoadEnd;
        try {
          // A press on a napping box wakes it first, as a message to it does.
          await ready();
          const owed = ledger.owed(machine);
          const spared = [...ledger.live].map(p => `! -path ${shellQuote(p)}`).join(" ");
          const written = await putFiles(
            machine,
            [
              ...Object.entries(files()).map(([name, text]) => ({ path: `${dir}/${name}`, text })),
              { path: `${payload}/env`, text: nulSeparated(Object.entries(o.env).flat()) },
              { path: `${payload}/args`, text: nulSeparated(o.args) },
              { path: `${payload}/in`, text: Buffer.from(o.stdin ?? "", "utf8").toString("base64") },
            ],
            {
              before: [
                "umask 077",
                ...owed.map(path => `rm -rf ${shellQuote(path)}`),
                // The folder holds what the record holds and nothing else, and no thread's folder here keeps the values
                // of a run this host is not running: a run whose cleanup never came back leaves them for this sweep.
                `mkdir -p ${shellQuote(dir)}`,
                `find ${shellQuote(dir)} -mindepth 1 -maxdepth 1 ! -name '.run-*' -exec rm -rf {} +`,
                `find ${shellQuote(BOX_SLATES)} -mindepth 2 -maxdepth 2 -name '.run-*' ${spared} -exec rm -rf {} +`,
                `mkdir -m 700 ${shellQuote(payload)}`,
              ],
            },
          );
          if (written.exitCode !== 0) throw new Error(`the slate's files did not reach the thread's machine: ${written.stderr.trim() || `exit ${written.exitCode}`}`);
          ledger.paid(machine, owed);
          const res = await machine.run(boxLauncher({ payload, cwd: o.cwd, cmd: o.cmd }), {
            deadlineMs: o.timeoutS * 1_000,
            ...(o.stream ? { onLine: (text: string) => on.line("out", text) } : {}),
            signal: cancel.signal,
            unlogged: true,
          });
          const room = Math.max(0, EXEC_OUTPUT_MAX - res.stdout.length);
          end = { code: res.exitCode, out: res.stdout.slice(0, EXEC_OUTPUT_MAX), err: res.stderr.slice(0, room), cut: res.stdout.length + res.stderr.length > EXEC_OUTPUT_MAX, timedOut: res.exitCode === DEADLINE_EXIT };
        } catch (e) {
          end = { code: null, error: e instanceof Error ? e : new Error(String(e)), out: "", err: "", cut: false, timedOut: false };
        }
        // A command killed before its launcher read the values leaves them, and a box that does not answer this
        // removal owes it; the run ends once its values are gone or owed.
        await ledger.remove(machine, payload);
        ledger.live.delete(payload);
        on.end(end);
      })();
      return { kill: () => cancel.abort() };
    },
    reshape(o): Reshape {
      let kill = (): void => {};
      const done = new Promise<ReturnType<typeof reshapeAnswer>>(settle => {
        kill = road.start({ cmd: o.cmd, args: [], cwd: o.cwd, env: o.env, stdin: o.input, timeoutS: o.timeoutS, stream: false }, { line: () => {}, end: (end: RoadEnd) => settle(reshapeAnswer(end, o.timeoutS, o.scrub)) }).kill;
      });
      return { done, kill: () => kill() };
    },
  };
  return road;
}
