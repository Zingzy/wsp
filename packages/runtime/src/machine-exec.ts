// ExecStreamFactory over a Machine's one-shot REST exec, for running harnesses
// on remote workspaces. The command is launched detached inside the guest
// (setsid + log file), because REST-launched processes survive machine
// pause/resume while control-channel children get reaped (PoC P10/P4b). The
// stream then polls the log, so a mid-turn nap only stalls polling: polls fail
// while the machine is paused, recover after wake, and the turn's own output
// picks up where it left off. The engine's execDetached runs the same launch
// and poll contract for a command that ends on its own; this one streams and
// can be signalled while it runs, which is what a harness turn needs. A stream
// started with an input channel gets a file the launch seeds and every write()
// appends to with one exec; a tail feeds it to the command's stdin through a
// fifo, so a message reaches a running process the runtime holds no pipe to.
// The tail's pid is recorded: closeInput() kills it so the command reads EOF,
// and the script kills it once the command ended, so nothing outlives the turn.

import { randomBytes } from "node:crypto";
import { INLINE_EXEC_MS, type ExecResult, type Machine } from "@wsp/engine";
import type { ExecStream, ExecStreamFactory } from "@wsp/adapter-claude";
import { shellQuote } from "@wsp/protocol";

export interface MachineExecOptions {
  /** Delay between log polls. */
  pollMs?: number;
  /** Hard ceiling for one stream; the stream ends with exit null past it. */
  deadlineMs?: number;
  /** Per-poll REST exec timeout. */
  execTimeoutMs?: number;
  /** Directory inside the guest for script/log/pid/exit files. */
  runDir?: string;
  /** The clock the deadline reads. */
  now?: () => number;
}

const CHUNK_BYTES = 262_144;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function machineExecStream(machine: Machine, opts: MachineExecOptions = {}): ExecStreamFactory {
  const pollMs = opts.pollMs ?? 1500;
  const deadlineMs = opts.deadlineMs ?? 900_000;
  const execTimeoutMs = opts.execTimeoutMs ?? INLINE_EXEC_MS;
  const runDir = opts.runDir ?? "/tmp/wsp-run";
  const now = opts.now ?? Date.now;

  return (command, { env, input }) => {
    const id = randomBytes(6).toString("hex");
    const base = `${runDir}/${id}`;
    const sentinel = `__WSP_EOF_${id}__`;
    const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

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
    const channel = input === undefined ? "" : `printf '%s' '${b64(input.map(line => `${line}\n`).join(""))}' | base64 -d > ${base}.in; mkfifo ${base}.fifo; `;
    // exec honours no idempotency key and a launch whose answer was lost is retried; the claim makes the second a no-op.
    const launchCmd =
      `mkdir -p ${runDir}; mkdir ${base}.d 2>/dev/null || { echo WSP_LAUNCHED; exit 0; }; ` +
      `printf '%s' '${b64(`${exports}\n${run}`)}' | base64 -d > ${base}.sh; ${channel}` +
      `setsid bash ${base}.sh > ${base}.log 2>&1 & echo $! > ${base}.pid; echo WSP_LAUNCHED`;

    let killed = false;
    let inputClosed = false;
    let startedAt = now();
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
    const launched: Promise<ExecResult> = machine.exec(launchCmd, { timeoutMs: execTimeoutMs });

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

    // The exit file is read before the log, so a poll that sees an exit code reads a log that is complete.
    const pollCmd = (offset: number): string =>
      `E=$(cat ${base}.exit 2>/dev/null); ` +
      `tail -c +${offset + 1} ${base}.log 2>/dev/null | head -c ${CHUNK_BYTES} | base64 -w0; ` +
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
        finish(null);
        const detail = launch instanceof Error ? launch.message : `exit ${launch.exitCode}: ${launch.stderr}`;
        throw new Error(`remote launch failed on ${machine.id}: ${detail}`);
      }

      while (true) {
        if (killed) {
          finish(null);
          return;
        }
        if (now() - startedAt > deadlineMs) {
          signal("KILL");
          finish(null);
          throw new Error(`remote stream deadline (${deadlineMs}ms) exceeded on ${machine.id}`);
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
          finish(Number.parseInt(exitStr, 10));
          return;
        }
        // The pid is checked after the exit file: a leader that finished in between shows as down with no exit yet.
        if (live === "down" && ++downs > 1) {
          const tail = drainPending();
          if (tail !== undefined) yield tail;
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
        // The guest knows the command ended the moment its exit file exists, up to a poll before this side does.
        const res = await machine.exec(
          `[ -e ${base}.exit ] && { echo WSP_GONE; exit 0; }; printf '%s' '${b64(`${line}\n`)}' | base64 -d >> ${base}.in; echo WSP_OK`,
          { timeoutMs: execTimeoutMs },
        );
        if (res.stdout.includes("WSP_GONE")) return "gone";
        if (res.exitCode !== 0 || !res.stdout.includes("WSP_OK")) throw new Error(`remote write failed on ${machine.id}: exit ${res.exitCode}: ${res.stderr}`);
        // The person just acted, so the turn gets its deadline over.
        startedAt = now();
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
