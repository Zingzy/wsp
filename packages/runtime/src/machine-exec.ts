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
// and were seen holding 90 MB each for the machine's life. A launch nothing
// answered (this computer's DNS gone, a reset connection, a gateway error the
// backend gave up on) is posted again at the engine's backoff for its reach
// window before the turn fails; the claim makes one that did land a no-op.
// The run outlives the process that launched it, so the factory also attaches
// to one by the handle its stream reported: the log on the guest is the whole
// turn, and a reader that comes later reads it from its first byte. The claim
// directory is what says the run is still there; the reap takes it with the
// rest, so an attach to a swept run answers gone instead of hanging.

import { randomBytes } from "node:crypto";
import { INLINE_EXEC_MS, MachineUnreached, putFiles, realRetryClock, untilReached, type ExecResult, type GuestWrite, type Machine } from "@wsp/engine";
import { EXEC_CHUNK_BYTES, RUN_GONE_LINE, TURN_IDLE_MS, TURN_WALL_MS, shellQuote, turnCutLine, workScoreLine } from "@wsp/protocol";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";

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
  /** What every wait runs on, the poll's and the launch retry's; tests hand in one that moves the clock. */
  sleep?: (ms: number) => Promise<void>;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function machineExecStream(machine: Machine, opts: MachineExecOptions = {}): ExecStreamFactory {
  const pollMs = opts.pollMs ?? 1500;
  const idleMs = opts.idleMs ?? TURN_IDLE_MS;
  const deadlineMs = opts.deadlineMs ?? TURN_WALL_MS;
  const execTimeoutMs = opts.execTimeoutMs ?? INLINE_EXEC_MS;
  const runDir = opts.runDir ?? "/tmp/wsp-run";
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realRetryClock.sleep;

  /** The one reader both roads share: a launch that has just posted its script, and an attach to a run an earlier
   * host process left behind. `opened` settles once the run is known to be on the machine and rejects with the words
   * the turn fails on when it is not. The log is read from its first byte either way, so a run that printed while no
   * host was listening is replayed to whoever attaches. */
  const open = (base: string, hasInput: boolean, opened: Promise<void>): ExecStream => {
    const sentinel = `__WSP_EOF_${randomBytes(6).toString("hex")}__`;

    let killed = false;
    let inputClosed = false;
    // Both limits run from this reader's first second: nothing on the machine records when the run's last byte
    // landed, so an attach cannot inherit an idle clock and starts the turn's cap again.
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

    const signal = (sig: "TERM" | "KILL"): void => {
      void opened
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

      try {
        await opened;
      } catch (e) {
        await reap();
        finish(null);
        throw e;
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
      run: base,
      teardown: () => signal("TERM"),
      kill: () => {
        killed = true;
        signal("KILL");
      },
      write: async line => {
        if (!hasInput) throw new Error("this stream has no input channel");
        if (finishCode !== undefined) throw new Error("the stream has ended");
        await opened;
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
        if (!hasInput || inputClosed || finishCode !== undefined) return;
        inputClosed = true;
        void opened
          .catch(() => undefined)
          .then(() => machine.exec(`P=$(cat ${base}.tail 2>/dev/null); [ -n "$P" ] && kill -TERM "$P" 2>/dev/null; true`, { timeoutMs: execTimeoutMs }))
          .catch(() => undefined);
      },
      exited,
    };
    return stream;
  };

  const factory: ExecStreamFactory = (command, { env, input }) => {
    const base = `${runDir}/${randomBytes(6).toString("hex")}`;

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
    // The turn's processes are what the kernel takes first when memory runs out: the work outgrew the machine, and
    // the daemon and the guest agent are how anyone hears of it.
    const files: GuestWrite[] = [{ path: `${base}.sh`, text: `${workScoreLine()}\n${exports}\n${run}` }];
    if (input !== undefined) files.push({ path: `${base}.in`, text: input.map(line => `${line}\n`).join("") });

    // Spawn eagerly, like a local child process would.
    const posted: Promise<ExecResult> = untilReached(
      () =>
        putFiles(machine, files, {
          // exec honours no idempotency key and a launch whose answer was lost is retried; the claim makes the second a no-op.
          before: [`mkdir ${base}.d 2>/dev/null || { echo WSP_LAUNCHED; exit 0; }`],
          after: [...(input === undefined ? [] : [`mkfifo ${base}.fifo`]), `setsid bash ${base}.sh > ${base}.log 2>&1 & echo $! > ${base}.pid; echo WSP_LAUNCHED`],
          timeoutMs: execTimeoutMs,
        }),
      { now, sleep },
    );
    const opened = posted.then(
      res => {
        if (res.exitCode !== 0 || !res.stdout.includes("WSP_LAUNCHED")) throw new Error(`remote launch failed on ${machine.id}: exit ${res.exitCode}: ${res.stderr}`);
      },
      (e: unknown) => {
        if (e instanceof MachineUnreached) throw e;
        throw new Error(`remote launch failed on ${machine.id}: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    return open(base, input !== undefined, opened);
  };

  // The claim directory is what says a run is still on the machine: the launch makes it and the reap takes it with
  // the rest of the run's files, so a run swept while no host was listening answers gone rather than silence.
  factory.attach = (run, { input }) =>
    open(
      run,
      input,
      machine.exec(`[ -d ${run}.d ] && echo WSP_RUN || echo WSP_GONE`, { timeoutMs: execTimeoutMs }).then(res => {
        if (!res.stdout.includes("WSP_RUN")) throw new Error(RUN_GONE_LINE);
      }),
    );

  return factory;
}
