// SPDX-License-Identifier: AGPL-3.0-only
// This computer's own processes, the processes module of the local kind: ps
// for the columns the pane already shows, filtered to the person's own
// processes, since this machine is theirs and another account's work is not
// the workspace's. Two reads per tick, because both the accounting name and
// the argv can hold spaces and one row cannot carry both unambiguously: the
// name read is pid then the rest of the line, and the column read ends in the
// argv. The C locale is forced because the start time is a printed date, and
// -ww because ps formats to a window: with no terminal on any of its streams
// a Mac's ps falls back to 79 columns and cuts every row there, which would
// leave about thirteen characters of the command column, and a daemon has
// pipes for streams.
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { cLocale } from "./host-command.js";
import { psCpuSeconds, type ProcEntry, type ProcInspectReply } from "@wsp/protocol";
import type { PortSnapshotSource } from "./ports.js";
import { CMDLINE_BYTES, PROC_CAP, type ProcScan, type ProcScanInput, type ProcSource } from "./proc.js";
import { OpError } from "./workspace-paths.js";

const run = promisify(execFile);
/** A machine with a thousand processes prints a few hundred kilobytes, where the default cap is one megabyte. */
const READ_CAP = 8 * 1024 * 1024;

/** ps prints resident memory in kibibytes. */
const RSS_UNIT = 1024;

/** The columns the pane reads, in one order both platforms print: the identity, the state, the memory the table
 * sorts on, the cpu the machine has spent, the start time as a date, and the argv last, which is the only column
 * allowed to hold spaces here. */
const PS_COLUMNS = "pid=,ppid=,state=,user=,rss=,time=,lstart=,args=";
/** The accounting name on its own, where everything after the pid is the name however many spaces it holds. */
const PS_NAMES = "pid=,ucomm=";

/** One row: five fields, then the cumulative cpu, then the five words of a printed date, then the argv. */
const ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/;
const NAME_ROW = /^\s*(\d+)\s+(\S.*?)\s*$/;

/** One process as ps read it, before the sampler's own clock turns its cpu time into a share of the window. */
export interface PsRow extends Omit<ProcEntry, "cpu" | "comm"> {
  /** Seconds of cpu this process has spent since it started. */
  cpuSeconds: number;
}

/** The accounting names by pid. A name may hold spaces (Google Chrome Helper) and is the OS's own truncation of
 * the command, which is what the guest's road reads out of /proc too, so a label rule matches the same word on
 * either kind. */
export function parsePsNames(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = NAME_ROW.exec(line);
    if (m !== null) names.set(Number(m[1]), m[2]!);
  }
  return names;
}

/** ps rows into the columns the pane shows. A row whose columns do not parse is dropped rather than failing the
 * scan: one unreadable process must not empty the table. The state word carries flags on both platforms (Ss, R+),
 * and /proc's is one letter, so both kinds show the letter. A kernel thread has no argv and Linux ps prints its
 * name in brackets instead; the pane draws that from the accounting name, as it does for a guest's, so the command
 * of such a row is empty on both kinds. */
export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = ROW.exec(line);
    if (m === null) continue;
    const startedAt = Date.parse(m[7]!);
    if (!Number.isFinite(startedAt)) continue;
    const args = m[8]!;
    const bracketed = args.startsWith("[") && args.endsWith("]");
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      user: m[4]!,
      state: m[3]![0]!,
      cmdline: bracketed ? "" : Buffer.from(args, "utf8").subarray(0, CMDLINE_BYTES).toString("utf8"),
      cpuSeconds: psCpuSeconds(m[6]!),
      rss: Number(m[5]) * RSS_UNIT,
      startedAt,
    });
  }
  return rows.sort((a, b) => a.pid - b.pid);
}

export interface LocalProcOptions {
  /** Whose processes the pane lists: the person running the host by default, which is whose machine this is. */
  user?: string;
  /** The listening ports of this computer, the road the daemon already reads them by, so inspect names a pid's
   * ports without a second reader of its own. */
  ports: PortSnapshotSource;
  cap?: number;
}

/** What a pid was doing at the last scan, so the next one has a window to divide by. */
interface Spent {
  startedAt: number;
  cpuSeconds: number;
}

/** This computer's processes as the person's own ps shows them. */
export class LocalProcSource implements ProcSource {
  private readonly user: string;
  private readonly ports: PortSnapshotSource;
  private readonly cap: number;
  /** Per pid across scans, the cpu time the next delta runs from; a pid whose start time moved is a new process. */
  private spent = new Map<number, Spent>();

  constructor(opts: LocalProcOptions) {
    this.user = opts.user ?? userInfo().username;
    this.ports = opts.ports;
    this.cap = opts.cap ?? PROC_CAP;
  }

  async scan({ elapsedMs, pty }: ProcScanInput): Promise<ProcScan> {
    const [printed, named] = await Promise.all([this.read(PS_COLUMNS), this.read(PS_NAMES)]);
    const names = parsePsNames(named);
    const rows = parsePs(printed);
    const seen = new Set<number>();
    const procs = rows.slice(0, this.cap).map(row => {
      seen.add(row.pid);
      const id = pty(row.pid);
      const { cpuSeconds, ...entry } = row;
      return {
        ...entry,
        // A pid ps named between the two reads carries no name until the next tick rather than a guessed one.
        comm: names.get(row.pid) ?? "",
        cpu: this.share(row, cpuSeconds, elapsedMs),
        ...(id !== undefined ? { pty: id } : {}),
      };
    });
    for (const pid of this.spent.keys()) if (!seen.has(pid)) this.spent.delete(pid);
    return { total: rows.length, procs };
  }

  /** The busy share of one core over the window just passed, the same column the guest's road reads out of its own
   * tick counters. ps's own %cpu is not that: on Linux it is the average over the whole life of the process, so a
   * process that burned a second an hour ago still reads busy. Linux ps prints whole seconds of cpu, so this
   * quantises there; macOS prints hundredths. */
  private share(row: PsRow, cpuSeconds: number, elapsedMs: number): number {
    const before = this.spent.get(row.pid);
    this.spent.set(row.pid, { startedAt: row.startedAt, cpuSeconds });
    if (before === undefined || before.startedAt !== row.startedAt || elapsedMs <= 0) return 0;
    return Math.max(0, ((cpuSeconds - before.cpuSeconds) / (elapsedMs / 1000)) * 100);
  }

  /** ps exits non-zero with what it printed when a selection matches nothing, so a run that printed rows is read
   * whatever its status; one that printed nothing is a machine this module cannot read, and the refusal travels so
   * the pane says so instead of showing an empty table as a fact. */
  private async read(columns: string): Promise<string> {
    return run("ps", ["-ww", "-U", this.user, "-o", columns], { ...cLocale(), maxBuffer: READ_CAP }).then(
      r => r.stdout,
      (e: { stdout?: string }) => {
        if (typeof e.stdout === "string" && e.stdout.trim() !== "") return e.stdout;
        throw e;
      },
    );
  }

  /** What this computer can say about one process beyond its row: the ports it listens on, from the same road the
   * ports pane rides, its folder from lsof, and its children out of the scan. ps carries no thread count on macOS,
   * so no kind reads one here and the field is left off. */
  async inspect(pid: number, procs: readonly ProcEntry[]): Promise<ProcInspectReply> {
    if (!procs.some(p => p.pid === pid)) throw new OpError("not-found", `no process ${pid}`);
    const listening = await this.ports();
    const ports = [...new Set(listening.filter(r => r.pid === pid).map(r => r.port))].sort((a, b) => a - b);
    return { pid, cwd: await workingFolder(pid), ports, children: procs.filter(p => p.ppid === pid).map(p => p.pid) };
  }
}

/** The folder a process is in, as lsof names it: the one road to another process's cwd that answers on both
 * platforms, since /proc has it on Linux only. Null where lsof is absent or the process is out of reach, which is
 * what the pane already prints as unreadable. */
async function workingFolder(pid: number): Promise<string | null> {
  const printed = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], cLocale()).then(
    r => r.stdout,
    (e: { stdout?: string }) => e.stdout ?? "",
  );
  const named = printed.split("\n").find(l => l.startsWith("n") && l.length > 1);
  return named === undefined ? null : named.slice(1);
}
