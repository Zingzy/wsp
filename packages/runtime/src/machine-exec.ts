// ExecStreamFactory over a Machine's one-shot REST exec, for running harnesses
// on remote workspaces. The command is launched detached inside the guest
// (setsid + log file), because REST-launched processes survive machine
// pause/resume while control-channel children get reaped (PoC P10/P4b). The
// stream then polls the log, so a mid-turn nap only stalls polling: polls fail
// while the machine is paused, recover after wake, and the turn's own output
// picks up where it left off. The script goes up through the engine's
// putFiles, so it lands under the exec body cap however long it is; the
// engine's execDetached polls the same way for a command that ends on its
// own, while this one streams and can be signalled while it runs, which is
// what a harness turn needs. A stream started with an input channel gets a
// file the launch seeds and every write() appends to through putFiles; a tail
// feeds it to the command's stdin through a fifo, so a message reaches a
// running process the runtime holds no pipe to. The tail's pid is recorded:
// closeInput() kills it so the command reads EOF, and the script kills it once
// the command ended. When the stream ends, however it ends, the recorded
// process group gets TERM then KILL and the run's files go: the CLI's own
// children (MCP servers under npx) stay in the setsid group after it exits,
// and were seen holding 90 MB each for the machine's life.

import { randomBytes } from "node:crypto";
import { INLINE_EXEC_MS, putFiles, type ExecResult, type GuestWrite, type Machine } from "@wsp/engine";
import type { ExecStream, ExecStreamFactory } from "@wsp/adapter-claude";
import { EXEC_CHUNK_BYTES, TURN_IDLE_MS, TURN_WALL_MS, shellQuote, turnCutLine } from "@wsp/protocol";

export interface MachineExecOptions {
  /** Delay between log polls. */
  pollMs?: number;
  /** How long the log may stay quiet, write() included, before the stream ends with exit null and the idle line. */
  idleMs?: number;
  /** The cap on one stream however much it prints; the stream ends with exit null and the wall line past it. */
  deadlineMs?: number;
  /** Per-poll REST exec timeout. */
  execTimeoutMs?: number;
  /** Directory inside the guest for script/log/pid/exit files. */
  runDir?: string;
  /** The clock both limits read. */
  now?: () => number;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function machineExecStream(machine: Machine, opts: MachineExecOptions = {}): ExecStreamFactory {
  const pollMs = opts.pollMs ?? 1500;
  const idleMs = opts.idleMs ?? TURN_IDLE_MS;
  const deadlineMs = opts.deadlineMs ?? TURN_WALL_MS;
  const execTimeoutMs = opts.execTimeoutMs ?? INLINE_EXEC_MS;
  const runDir = opts.runDir ?? "/tmp/wsp-run";
  const now = opts.now ?? Date.now;

  return (command, { env, input }) => {
    const id = randomBytes(6).toString("hex");
    const base = `${runDir}/${id}`;
    const sentinel = `__WSP_EOF_${id}__`;

    const exports = Object.entries(env)
      .filter(([k]) => ENV_KEY.test(k))
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("\n");
    // The tail starts in a subshell so bash's job notice for its kill never lands in the log; the command's exit code
    // is written before the tail is killed, so a poll that sees it reads a finished log.
    const run =
      input === undefined
        ? `${command}\necho $? > ${base}.exit\n`
        : `( tail -n +1 -f ${base}.in > ${base}.fifo & echo $! > ${base}.tail )\n{ ${command}\n} < ${base}.fifo\necho $? > ${base}.exit\nkill $(cat ${base}.tail) 2>/dev/null\n`;
    const files: GuestWrite[] = [{ path: `${base}.sh`, text: `${exports}\n${run}` }];
    if (input !== undefined) files.push({ path: `${base}.in`, text: input.map(line => `${line}\n`).join("") });

    let killed = false;
    let inputClosed = false;
    const startedAt = now();
    let lastByteAt = startedAt;
    let finishCode: number | null | undefined;
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => {
      resolveExit = resolve;
    });
    const finish = (code: number | null): void => {
      if (finishCode === undefined) {
        finishCode = code;
        resolveExit(code);
      }
    };

    // Spawn eagerly, like a local child process would.
    const launched: Promise<ExecResult> = putFiles(machine, files, {
      // exec honours no idempotency key and a launch whose answer was lost is retried; the claim makes the second a no-op.
      before: [`mkdir ${base}.d 2>/dev/null || { echo WSP_LAUNCHED; exit 0; }`],
      after: [...(input === undefined ? [] : [`mkfifo ${base}.fifo`]), `setsid bash ${base}.sh > ${base}.log 2>&1 & echo $! > ${base}.pid; echo WSP_LAUNCHED`],
      timeoutMs: execTimeoutMs,
    });

    const signal = (sig: "TERM" | "KILL"): void => {
      void launched
        .catch(() => undefined)
        .then(() =>
          machine.exec(`P=$(cat ${base}.pid 2>/dev/null); [ -n "$P" ] && kill -${sig} -- -$P 2>/dev/null; true`, {
            timeoutMs: execTimeoutMs,
          }),
        )
        .catch(() => undefined);
    };

    // Runs after the last poll read the log, so the group's stragglers cannot cost the turn a line.
    const reap = (): Promise<void> =>
      machine
        .exec(
          `P=$(cat ${base}.pid 2>/dev/null); ` +
            `if [ -n "$P" ]; then kill -TERM -- -$P 2>/dev/null; ` +
            `for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- -$P 2>/dev/null || break; sleep 0.2; done; ` +
            `kill -KILL -- -$P 2>/dev/null; fi; ` +
            `rm -rf ${base}.*; true`,
          { timeoutMs: execTimeoutMs },
        )
        .then(() => undefined, () => undefined);

    // The exit file is read before the log, so a poll that sees an exit code reads a log that is complete.
    const pollCmd = (offset: number): string =>
      `E=$(cat ${base}.exit 2>/dev/null); ` +
      `tail -c +${offset + 1} ${base}.log 2>/dev/null | head -c ${EXEC_CHUNK_BYTES} | base64 -w0; ` +
      `P=$(cat ${base}.pid 2>/dev/null); ` +
      `printf '\\n${sentinel} %s %s\\n' "$E" ` +
      `"$([ -n "$P" ] && kill -0 "$P" 2>/dev/null && echo up || echo down)"`;

    async function* lines(): AsyncGenerator<string> {
      let offset = 0;
      let downs = 0;
      let pending = Buffer.alloc(0);
      const drainPending = (): string | undefined =>
        pending.length > 0 ? pending.toString("utf8") : undefined;

      const launch = await launched.catch((e: unknown) => e as Error);
      if (launch instanceof Error || launch.exitCode !== 0 || !launch.stdout.includes("WSP_LAUNCHED")) {
        await reap();
        finish(null);
        const detail = launch instanceof Error ? launch.message : `exit ${launch.exitCode}: ${launch.stderr}`;
        throw new Error(`remote launch failed on ${machine.id}: ${detail}`);
      }

      while (true) {
        if (killed) {
          await reap();
          finish(null);
          return;
        }
        const elapsed = now() - startedAt;
        const cut = elapsed >= deadlineMs ? "wall" : now() - lastByteAt >= idleMs ? "idle" : undefined;
        if (cut !== undefined) {
          await reap();
          finish(null);
          throw new Error(turnCutLine(cut, elapsed, cut === "wall" ? deadlineMs : idleMs));
        }

        let res: ExecResult;
        try {
          res = await machine.exec(pollCmd(offset), { timeoutMs: execTimeoutMs });
        } catch {
          // Machine likely napping; polls recover after wake (P10 semantics).
          await sleep(pollMs);
          continue;
        }

        const out = res.stdout.split("\n");
        const markIdx = out.findIndex(l => l.startsWith(sentinel));
        if (markIdx === -1) {
          await sleep(pollMs);
          continue;
        }
        const [, exitStr = "", live = "up"] = out[markIdx]!.split(" ");
        const chunk = Buffer.from(out.slice(0, markIdx).join(""), "base64");
        offset += chunk.length;

        if (chunk.length > 0) {
          lastByteAt = now();
          pending = Buffer.concat([pending, chunk]);
          let nl: number;
          while ((nl = pending.indexOf(0x0a)) !== -1) {
            yield pending.subarray(0, nl).toString("utf8");
            pending = pending.subarray(nl + 1);
          }
          continue; // there may be more than one chunk buffered up
        }

        if (exitStr !== "") {
          const tail = drainPending();
          if (tail !== undefined) yield tail;
          await reap();
          finish(Number.parseInt(exitStr, 10));
          return;
        }
        // The pid is checked after the exit file: a leader that finished in between shows as down with no exit yet.
        if (live === "down" && ++downs > 1) {
          const tail = drainPending();
          if (tail !== undefined) yield tail;
          await reap();
          finish(null);
          return;
        }
        await sleep(pollMs);
      }
    }

    const stream: ExecStream = {
      lines: lines(),
      teardown: () => signal("TERM"),
      kill: () => {
        killed = true;
        signal("KILL");
      },
      write: async line => {
        if (input === undefined) throw new Error("this stream has no input channel");
        if (finishCode !== undefined) throw new Error("the stream has ended");
        await launched;
        // The guest knows the command ended the moment its exit file exists, up to a poll before this side does,
        // and a reap in flight has taken the claim with the rest of the run.
        const res = await putFiles(machine, [{ path: `${base}.in`, text: `${line}\n`, append: true }], {
          before: [`{ [ -e ${base}.exit ] || [ ! -d ${base}.d ]; } && { echo WSP_GONE; exit 0; }`],
          after: ["echo WSP_OK"],
          timeoutMs: execTimeoutMs,
        });
        if (res.stdout.includes("WSP_GONE")) return "gone";
        if (res.exitCode !== 0 || !res.stdout.includes("WSP_OK")) throw new Error(`remote write failed on ${machine.id}: exit ${res.exitCode}: ${res.stderr}`);
        // The person just acted, so the turn gets its idle time over.
        lastByteAt = now();
        return "written";
      },
      closeInput: () => {
        if (input === undefined || inputClosed || finishCode !== undefined) return;
        inputClosed = true;
        void launched
          .catch(() => undefined)
          .then(() => machine.exec(`P=$(cat ${base}.tail 2>/dev/null); [ -n "$P" ] && kill -TERM "$P" 2>/dev/null; true`, { timeoutMs: execTimeoutMs }))
          .catch(() => undefined);
      },
      exited,
    };
    return stream;
  };
}
