// SPDX-License-Identifier: AGPL-3.0-only
// A slate's command on the thread's own machine (07-runs, "on"): a box, a cloud machine, or a workspace on a computer
// somebody owns, all through the engine's Machine, the road a turn there runs on. Before each command the slate's
// files are written to its folder there and the command's values go up beside them base64, in files only the run's
// account reads; a fixed launcher decodes them, deletes them before the command starts, and runs the agent's text as
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

/** Items each ended by a NUL byte, base64: what a value may hold reaches the launcher whole, newlines and all. */
const nulSeparated = (items: readonly string[]): string => Buffer.from(items.map(item => `${item}\0`).join(""), "utf8").toString("base64");

/** The script the machine runs for one command. `payload` is the path the values went up under. */
export function boxLauncher(o: { payload: string; cwd: string; cmd: string }): string {
  return [
    "set -u",
    `p=${shellQuote(o.payload)}`,
    `base64 -d < "$p.env" > "$p.env0" && base64 -d < "$p.args" > "$p.args0" && base64 -d < "$p.in" > "$p.in0" || { echo "the run's values did not arrive" >&2; exit 1; }`,
    `rm -f "$p.env" "$p.args" "$p.in"`,
    `while IFS= read -r -d '' k && IFS= read -r -d '' v; do export "$k=$v"; done < "$p.env0"`,
    `a=(); while IFS= read -r -d '' x; do a+=("$x"); done < "$p.args0"`,
    `exec 3< "$p.in0"`,
    `rm -f "$p.env0" "$p.args0" "$p.in0"`,
    `cd ${shellQuote(o.cwd)} 2>/dev/null || { echo ${shellQuote(`the folder ${o.cwd} does not exist`)} >&2; exit 1; }`,
    `exec bash -c ${shellQuote(o.cmd)} bash \${a[@]+"\${a[@]}"} <&3`,
  ].join("\n");
}

/** The thread's machine as the road its slate's commands run on. `files` reads the slate's files as they are now. */
export function boxRoad(machine: Machine, threadId: string, files: () => Readonly<Record<string, string>>): RunRoad {
  const dir = boxSlateDir(threadId);
  const road: RunRoad = {
    slateDir: dir,
    start(o, on) {
      const cancel = new AbortController();
      const payload = `${dir}/.run-${randomBytes(6).toString("hex")}`;
      const failed = (e: unknown): void => on.end({ code: null, error: e instanceof Error ? e : new Error(String(e)), out: "", err: "", cut: false, timedOut: false });
      void (async () => {
        try {
          const written = await putFiles(
            machine,
            [
              ...Object.entries(files()).map(([name, text]) => ({ path: `${dir}/${name}`, text })),
              { path: `${payload}.env`, text: nulSeparated(Object.entries(o.env).flat()) },
              { path: `${payload}.args`, text: nulSeparated(o.args) },
              { path: `${payload}.in`, text: Buffer.from(o.stdin ?? "", "utf8").toString("base64") },
            ],
            // The folder holds what the record holds and nothing else; the values of commands still starting stay.
            { before: ["umask 077", `mkdir -p ${shellQuote(dir)}`, `find ${shellQuote(dir)} -mindepth 1 -maxdepth 1 ! -name '.run-*' -exec rm -rf {} +`] },
          );
          if (written.exitCode !== 0) throw new Error(`the slate's files did not reach the thread's machine: ${written.stderr.trim() || `exit ${written.exitCode}`}`);
          const res = await machine.run(boxLauncher({ payload, cwd: o.cwd, cmd: o.cmd }), {
            deadlineMs: o.timeoutS * 1_000,
            ...(o.stream ? { onLine: (text: string) => on.line("out", text) } : {}),
            signal: cancel.signal,
            unlogged: true,
          });
          const room = Math.max(0, EXEC_OUTPUT_MAX - res.stdout.length);
          on.end({ code: res.exitCode, out: res.stdout.slice(0, EXEC_OUTPUT_MAX), err: res.stderr.slice(0, room), cut: res.stdout.length + res.stderr.length > EXEC_OUTPUT_MAX, timedOut: res.exitCode === DEADLINE_EXIT });
        } catch (e) {
          failed(e);
        } finally {
          // A command killed before its launcher read the values leaves them; nothing else comes back for them.
          void machine.exec(`rm -f ${shellQuote(payload)}.*`).catch(() => undefined);
        }
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
