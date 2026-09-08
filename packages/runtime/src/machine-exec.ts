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
// rest, so an attach to a swept run answers gone instead of hanging. That
// question travels the launch road's reach window, and only the machine's own
// answer that the claim is gone may end a run: a probe nothing answered says
// nothing about the run it was sent to find, and killing that process group
// would end the very turn the attach exists to save. The same fact cuts the
// other way once a host has finished connecting: a run no row of that host
// holds is a harness process nobody will ever read again, so the sweep ends
// every claim on the machine that the caller did not name.

import { randomBytes } from "node:crypto";
import { INLINE_EXEC_MS, MachineUnreached, execFits, putFiles, realRetryClock, untilReached, type ExecResult, type GuestWrite, type Machine } from "@wsp/engine";
import { EXEC_CHUNK_BYTES, RUN_STOP_MS, TURN_IDLE_MS, TURN_WALL_MS, shellQuote, turnCutLine, workScoreLine } from "@wsp/protocol";
import type { ExecStream, ExecStreamFactory, TurnCutRule } from "@wsp/protocol";

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

/** The two limits a turn runs under on every kind of machine, and what ends one: the wall since it started, else the
 * idle stretch since its last byte or the person's last message. */
export interface TurnLimits {
  idleMs: number;
  deadlineMs: number;
}

/** The one rule that cuts a turn, whatever launched it: the error carrying turnCutLine when a limit has passed, else
 * nothing. The cloud road and the local child both read it, so a hung agent ends with the same words on either. */
export function turnCut(limits: TurnLimits, elapsedMs: number, quietMs: number): Error | undefined {
  const rule: TurnCutRule | undefined = elapsedMs >= limits.deadlineMs ? "wall" : quietMs >= limits.idleMs ? "idle" : undefined;
  return rule === undefined ? undefined : new Error(turnCutLine(rule, elapsedMs, rule === "wall" ? limits.deadlineMs : limits.idleMs));
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What a launch mints a run's name from, so a handle read back off the sessions index is checked against the shape
 * this code writes before it reaches shell text: a value that has been to a file on disk is no longer this code's. */
const RUN_ID = /^[0-9a-f]{12}$/;
/** How often the reap looks at the group it asked to go, while it waits out the one stop grace both roads give. */
const GRACE_POLL_MS = 200;
/** That grace as the shell's own counter, since a guest has no seq to lean on. */
const GRACE_CHECKS = Array.from({ length: Math.round(RUN_STOP_MS / GRACE_POLL_MS) }, (_, i) => String(i + 1)).join(" ");

export function machineExecStream(machine: Machine, opts: MachineExecOptions = {}): ExecStreamFactory {
  const pollMs = opts.pollMs ?? 1500;
  const idleMs = opts.idleMs ?? TURN_IDLE_MS;
  const deadlineMs = opts.deadlineMs ?? TURN_WALL_MS;
  const execTimeoutMs = opts.execTimeoutMs ?? INLINE_EXEC_MS;
  const runDir = opts.runDir ?? "/tmp/wsp-run";
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realRetryClock.sleep;

  /** The one path that says a run is on the machine: the launch makes it, the reap takes it with the rest of the
   * run's files, and every road that asks whether a run is still there asks about this one. */
  const claim = (base: string): string => `${base}.d`;
  /** What ending one run comes to on the guest, in the shell both the reader's own reap and the connect sweep run:
   * the recorded process group gets TERM, then KILL once the stop grace passes, and the run's files go. */
  const reapScript = (b: string): string =>
    `P=$(cat ${b}.pid 2>/dev/null); ` +
    `if [ -n "$P" ]; then kill -TERM -- -$P 2>/dev/null; ` +
    `for i in ${GRACE_CHECKS}; do kill -0 -- -$P 2>/dev/null || break; sleep ${GRACE_POLL_MS / 1000}; done; ` +
    `kill -KILL -- -$P 2>/dev/null; fi; ` +
    `rm -rf ${b}.*`;
  /** A handle this factory could have minted: the run directory it launches into and a name of its own shape. */
  const minted = (run: string): boolean => run.startsWith(`${runDir}/`) && RUN_ID.test(run.slice(runDir.length + 1));

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
      machine.exec(`${reapScript(base)}; true`, { timeoutMs: execTimeoutMs }).then(() => undefined, () => undefined);

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
        const cut = turnCut({ idleMs, deadlineMs }, now() - startedAt, now() - lastByteAt);
        if (cut !== undefined) {
          await reap();
          finish(null);
          throw cut;
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
          before: [`{ [ -e ${base}.exit ] || [ ! -d ${claim(base)} ]; } && { echo WSP_GONE; exit 0; }`],
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
          before: [`mkdir ${claim(base)} 2>/dev/null || { echo WSP_LAUNCHED; exit 0; }`],
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

  factory.attach = async (run, { input }) => {
    if (!minted(run)) throw new Error(`${run} is not a run this host could have launched`);
    const res = await untilReached(() => machine.exec(`[ -d ${claim(run)} ] && echo WSP_RUN || echo WSP_GONE`, { timeoutMs: execTimeoutMs }), { now, sleep });
    // Only these two answers say anything about the run. Anything else is the machine failing to answer the
    // question, which is the unreached road, not a run to end: the reader is built and the run swept on WSP_GONE
    // alone, so nothing here can take a live turn's process group with it.
    if (res.stdout.includes("WSP_RUN")) return open(run, input, Promise.resolve());
    if (res.stdout.includes("WSP_GONE")) return "gone";
    throw new Error(`the machine did not answer whether it still holds ${run}: exit ${res.exitCode}: ${res.stderr}`);
  };

  factory.sweep = async keep => {
    // The claims are what the machine holds, so the machine is asked what is there rather than told; the shape a
    // handle must have to be one of this factory's is read here, by the same predicate the attach road reads, so
    // nothing the guest wrote into the run directory reaches shell text on the strength of being there.
    const listed = await machine.exec(`for d in ${runDir}/*.d; do [ -d "$d" ] && printf '%s\\n' "$d"; done`, { timeoutMs: execTimeoutMs });
    const kept = new Set(keep);
    const stale = listed.stdout
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.endsWith(".d"))
      .map(line => line.slice(0, -".d".length))
      .filter(base => minted(base) && !kept.has(base));
    if (stale.length === 0) return [];
    // Each run's group is ended beside the others, not after them: every reap waits out its own stop grace, and a
    // machine holding a day of them would spend that grace once per run in a connect that has to end.
    const page = (bases: readonly string[]): string => `${bases.map(base => `{ ${reapScript(base)}; } &`).join(" ")} wait; true`;
    // The machine holding the most stale runs is the one this exists for, and it is the one whose command would pass
    // the exec body cap and be refused whole, so the reaps go a page at a time under the same rule every upload reads.
    const pages: string[][] = [[]];
    for (const base of stale) {
      const last = pages.at(-1)!;
      if (last.length > 0 && !execFits(page([...last, base]))) pages.push([base]);
      else last.push(base);
    }
    for (const bases of pages) await machine.exec(page(bases), { timeoutMs: execTimeoutMs });
    return stale;
  };

  return factory;
}
