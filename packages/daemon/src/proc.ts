// SPDX-License-Identifier: AGPL-3.0-only
// Every process on the machine as proc.snapshot events. The sampler holds the
// clock, the subscribers and the last scan; what a machine of one kind is read
// with is its own module behind ProcSource, registered in readings.ts. The
// module here is the guest's: straight from /proc, one stat file per pid per
// tick, cmdline only when a pid is new or exec'd, the uid from the pid
// directory's owner. One sampler per daemon; the first subscriber starts it
// and the last one leaving stops it. Inspecting one pid is the only path that
// touches /proc/net.
import { EventEmitter } from "node:events";
import { open, readdir, readFile, readlink, stat } from "node:fs/promises";
import type { ProcEntry, ProcInspectReply, ProcSignal, ProcSnapshot } from "@wsp/protocol";
import { parseProcNetTcp } from "./ports.js";
import { OpError } from "./workspace-paths.js";

/** /proc reports times in USER_HZ ticks, 100 a second on every Linux. */
const USER_HZ = 100;
/** The first bytes of a command line, whichever module read it: the whole of one can run to ARG_MAX and every row carries it. */
export const CMDLINE_BYTES = 200;
/** Rows one snapshot carries at most, whichever module read them; total counts what the machine had. */
export const PROC_CAP = 1000;
const AT_PAGESZ = 6;
/** Concurrent /proc reads per tick; the fs pool is four threads, so more only queues. */
const BATCH = 32;

export interface ProcStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  /** utime plus stime, in ticks. */
  ticks: number;
  threads: number;
  /** Ticks after boot. */
  starttime: number;
  rssPages: number;
}

/** The comm sits in parens and may hold anything, so the split runs from the last one. */
export function parseProcPidStat(text: string): ProcStat {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) throw new Error("/proc/[pid]/stat is malformed");
  const pid = Number(text.slice(0, open).trim());
  const f = text.slice(close + 1).trim().split(/\s+/);
  const n = (i: number): number => Number(f[i]);
  const out: ProcStat = {
    pid,
    comm: text.slice(open + 1, close),
    state: f[0] ?? "?",
    ppid: n(1),
    ticks: n(11) + n(12),
    threads: n(17),
    starttime: n(19),
    rssPages: n(21),
  };
  if ([pid, out.ppid, out.ticks, out.threads, out.starttime, out.rssPages].some(v => !Number.isFinite(v))) throw new Error("/proc/[pid]/stat is malformed");
  return out;
}

export function parseBtime(procStat: string): number {
  const m = /^btime\s+(\d+)/m.exec(procStat);
  if (!m) throw new Error("/proc/stat has no btime");
  return Number(m[1]);
}

/** auxv is an array of (type, value) native words; AT_PAGESZ carries the page size. */
export function parseAuxvPageSize(buf: Buffer): number | undefined {
  for (let i = 0; i + 16 <= buf.length; i += 16) {
    const type = buf.readBigUInt64LE(i);
    if (type === BigInt(0)) return undefined;
    if (type === BigInt(AT_PAGESZ)) return Number(buf.readBigUInt64LE(i + 8));
  }
  return undefined;
}

export function parsePasswdUsers(text: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of text.split("\n")) {
    const f = line.split(":");
    const uid = Number(f[2]);
    if (f.length >= 3 && f[0] && Number.isInteger(uid)) users.set(uid, f[0]);
  }
  return users;
}

/** What one scan read: every process the module shows, and how many there are before the cap. */
export interface ProcScan {
  total: number;
  procs: ProcEntry[];
}

export interface ProcScanInput {
  /** The clock this scan is stamped with. */
  at: number;
  /** Wall milliseconds since the last scan, 0 on the first, where a cpu delta has nothing to run from. */
  elapsedMs: number;
  /** The daemon pty a pid's shell belongs to, for the rows that carry one. */
  pty: (pid: number) => string | undefined;
}

/** One kind's road to the processes on its machine, and to one of them in depth. A machine wsp forks reads its own
 * /proc (ProcFsSource); this computer reads its own host with ps. Adding a kind is its module and the row in
 * readings.ts, nothing here. */
export interface ProcSource {
  scan(input: ProcScanInput): Promise<ProcScan>;
  /** One process in depth. `procs` is the newest scan, which is where the children column comes from. */
  inspect(pid: number, procs: readonly ProcEntry[]): Promise<ProcInspectReply>;
}

export interface ProcFsOptions {
  procRoot?: string;
  passwdPath?: string;
  cap?: number;
}

export interface ProcSamplerOptions {
  /** The daemon's own pid, named in every snapshot. */
  selfPid?: number;
  /** The daemon's ptys, so their shells carry the pty id. */
  ptys?: () => { id: string; pid: number }[];
  intervalMs?: number;
  now?: () => number;
}

interface Known {
  starttime: number;
  comm: string;
  ticks: number;
  cmdline: string;
  user: string;
}

/** The guest's own processes, read straight from /proc: the module every machine wsp forks is served by. */
export class ProcFsSource implements ProcSource {
  private readonly procRoot: string;
  private readonly passwdPath: string;
  private readonly cap: number;
  /** Per pid across scans: the ticks the cpu delta runs from, and what is only re-read after an exec. */
  private known = new Map<number, Known>();
  private btime: number | undefined;
  private pageSize = 4096;
  private users = new Map<number, string>();

  constructor(opts: ProcFsOptions = {}) {
    this.procRoot = opts.procRoot ?? "/proc";
    this.passwdPath = opts.passwdPath ?? "/etc/passwd";
    this.cap = opts.cap ?? PROC_CAP;
  }

  /** Reads every pid once; cpu is the tick delta against the last scan over the wall time between them. */
  async scan({ at, elapsedMs, pty }: ProcScanInput): Promise<ProcScan> {
    if (this.btime === undefined) await this.prime();
    const elapsedTicks = (elapsedMs / 1000) * USER_HZ;
    const pids = (await readdir(this.procRoot)).filter(d => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b);
    const procs: ProcEntry[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < Math.min(pids.length, this.cap); i += BATCH) {
      const batch = pids.slice(i, Math.min(i + BATCH, this.cap));
      const read = await Promise.all(batch.map(pid => this.readOne(pid, elapsedTicks, pty(pid))));
      for (const p of read) {
        if (p === undefined) continue;
        seen.add(p.pid);
        procs.push(p);
      }
    }
    for (const pid of this.known.keys()) if (!seen.has(pid)) this.known.delete(pid);
    return { total: pids.length, procs };
  }

  private async prime(): Promise<void> {
    this.btime = parseBtime(await readFile(`${this.procRoot}/stat`, "latin1"));
    const auxv = await readFile(`${this.procRoot}/self/auxv`).catch(() => undefined);
    this.pageSize = (auxv && parseAuxvPageSize(auxv)) || 4096;
    this.users = parsePasswdUsers(await readFile(this.passwdPath, "utf8").catch(() => ""));
  }

  private async readOne(pid: number, elapsedTicks: number, pty: string | undefined): Promise<ProcEntry | undefined> {
    const dir = `${this.procRoot}/${pid}`;
    let st: ProcStat;
    try {
      st = parseProcPidStat(await readFile(`${dir}/stat`, "latin1"));
    } catch {
      return undefined;
    }
    let k = this.known.get(pid);
    let cpu = 0;
    if (k !== undefined && k.starttime === st.starttime && elapsedTicks > 0) {
      cpu = Math.max(0, ((st.ticks - k.ticks) / elapsedTicks) * 100);
    }
    if (k === undefined || k.starttime !== st.starttime || k.comm !== st.comm) {
      // A new pid, or the same pid after an exec (the comm moved): the image changed, so cmdline and owner are read again.
      const [cmdline, uid] = await Promise.all([this.readCmdline(dir), stat(dir).then(s => s.uid, () => -1)]);
      k = { starttime: st.starttime, comm: st.comm, ticks: st.ticks, cmdline, user: this.users.get(uid) ?? String(uid) };
      this.known.set(pid, k);
    } else {
      k.ticks = st.ticks;
    }
    return {
      pid,
      ppid: st.ppid,
      user: k.user,
      state: st.state,
      comm: st.comm,
      cmdline: k.cmdline,
      cpu,
      rss: st.rssPages * this.pageSize,
      startedAt: (this.btime! + st.starttime / USER_HZ) * 1000,
      ...(pty !== undefined ? { pty } : {}),
    };
  }

  /** The first CMDLINE_BYTES only; a batch reads several at once, so each read has its own small buffer. */
  private async readCmdline(dir: string): Promise<string> {
    let fh;
    try {
      fh = await open(`${dir}/cmdline`, "r");
    } catch {
      return "";
    }
    try {
      const buf = Buffer.allocUnsafe(CMDLINE_BYTES);
      const { bytesRead } = await fh.read(buf, 0, CMDLINE_BYTES, 0);
      let end = bytesRead;
      while (end > 0 && buf[end - 1] === 0) end--;
      return buf.toString("utf8", 0, end).replaceAll("\0", " ");
    } catch {
      return "";
    } finally {
      await fh.close();
    }
  }

  async inspect(pid: number, procs: readonly ProcEntry[]): Promise<ProcInspectReply> {
    const dir = `${this.procRoot}/${pid}`;
    let st: ProcStat;
    try {
      st = parseProcPidStat(await readFile(`${dir}/stat`, "latin1"));
    } catch {
      throw new OpError("not-found", `no process ${pid}`);
    }
    const cwd = await readlink(`${dir}/cwd`).catch(() => null);
    const inodes = new Set<number>();
    for (const fd of await readdir(`${dir}/fd`).catch(() => [] as string[])) {
      const m = /^socket:\[(\d+)\]$/.exec(await readlink(`${dir}/fd/${fd}`).catch(() => ""));
      if (m) inodes.add(Number(m[1]));
    }
    const ports = new Set<number>();
    for (const file of ["tcp", "tcp6"]) {
      const text = await readFile(`${this.procRoot}/net/${file}`, "latin1").catch(() => "");
      for (const row of parseProcNetTcp(text)) if (row.inode !== undefined && inodes.has(row.inode)) ports.add(row.port);
    }
    const children = procs.filter(p => p.ppid === pid).map(p => p.pid);
    return { pid, cwd, ports: [...ports].sort((a, b) => a - b), threads: st.threads, children };
  }
}

export class ProcSampler extends EventEmitter {
  private readonly source: ProcSource;
  private readonly selfPid: number;
  private readonly ptys: () => { id: string; pid: number }[];
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private subscribers = 0;
  private inflight: Promise<void> | undefined;
  private lastAt: number | undefined;
  private lastProcs: ProcEntry[] = [];
  /** What the last tick said, so a watch that arrives mid-stream inherits it; undefined until one has finished. */
  private last: { error?: unknown } | undefined;

  constructor(source: ProcSource, opts: ProcSamplerOptions = {}) {
    super();
    this.source = source;
    this.selfPid = opts.selfPid ?? process.pid;
    this.ptys = opts.ptys ?? (() => []);
    this.intervalMs = opts.intervalMs ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  subscribe(fn: (e: ProcSnapshot) => void): () => void {
    this.on("proc.snapshot", fn);
    this.subscribers++;
    if (this.subscribers === 1) this.start();
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.off("proc.snapshot", fn);
      this.subscribers--;
      if (this.subscribers === 0) this.stop();
    };
  }

  /** One scan before a watch is taken, so a module that cannot read this machine refuses the op instead of leaving
   * the pane at pending for a stream that never comes. Its reading is thrown away: cpu is a delta, so the first
   * snapshot still lands one interval after the reply. A sampler already polling scans every interval anyway, so a
   * second watcher inherits what the last tick said rather than paying for a scan of its own, which would also run
   * beside that tick and leave the module's per pid state read from two clocks. */
  async probe(): Promise<void> {
    const last = this.last;
    if (this.timer !== null && last !== undefined) {
      if (last.error !== undefined) throw last.error;
      return;
    }
    await this.scan(0);
  }

  start(): void {
    if (this.timer) return;
    this.lastAt = undefined;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lastAt = undefined;
    this.last = undefined;
  }

  /** The first poll after a start is the cpu baseline and emits nothing; a failed read of one pid drops that pid for the tick. */
  poll(): Promise<void> {
    return (this.inflight ??= this.tick()
      .then(
        () => {
          this.last = {};
        },
        (e: unknown) => {
          this.last = { error: e };
        },
      )
      .finally(() => {
        this.inflight = undefined;
      }));
  }

  private async tick(): Promise<void> {
    const at = this.now();
    const scan = await this.scan(this.lastAt === undefined ? 0 : at - this.lastAt, at);
    const first = this.lastAt === undefined;
    this.lastAt = at;
    this.lastProcs = scan.procs;
    if (first) return;
    this.emit("proc.snapshot", { type: "proc.snapshot", at, daemon: this.selfPid, total: scan.total, procs: scan.procs } satisfies ProcSnapshot);
  }

  private scan(elapsedMs: number, at = this.now()): Promise<ProcScan> {
    // An exited pty's pid can be reused by a stranger; the map is rebuilt per scan from the shells live then.
    const ptyOf = new Map(this.ptys().map(p => [p.pid, p.id] as const));
    return this.source.scan({ at, elapsedMs, pty: pid => ptyOf.get(pid) });
  }

  async inspect(pid: number): Promise<ProcInspectReply> {
    const procs = this.lastAt === undefined ? (await this.scan(0)).procs : this.lastProcs;
    return this.source.inspect(pid, procs);
  }
}

/** Signals one process. init, the daemon and whatever started the daemon are never signalled: the workspace would go with them. */
export function killProcess(pid: number, signal: ProcSignal, protectedPids: { self: number; parent: number }): void {
  if (pid === 1 || pid === protectedPids.self || pid === protectedPids.parent) {
    throw new OpError("forbidden", `refusing to signal pid ${pid}: it is init, the daemon or the daemon's parent`);
  }
  try {
    process.kill(pid, signal === "KILL" ? "SIGKILL" : "SIGTERM");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") throw new OpError("not-found", `no process ${pid}`);
    if (code === "EPERM") throw new OpError("forbidden", `no permission to signal pid ${pid}`);
    throw e;
  }
}
