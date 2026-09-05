import { EventEmitter } from "node:events";
import { open, readdir, readFile, readlink } from "node:fs/promises";
import type { DaemonEvent } from "@wsp/protocol";

export interface ListeningPort {
  port: number;
  pid: number | null;
  inode: number;
  uid: number;
  /** /proc/<pid>/comm of the owner; unset when there is no pid or the read fails. */
  process?: string;
  /** /proc/<pid>/cmdline of the owner joined by spaces, at most CMDLINE_CAP_BYTES of it; unset like process. */
  command?: string;
  /** Bound to 127.0.0.1 or ::1 (or ::ffff:127.0.0.1) only: a sign-in callback listener; unreachable through the preview edge. */
  loopback: boolean;
}

const TCP_LISTEN = "0A";

/** /proc/net/tcp prints each 32-bit word of the address little-endian in hex:
 * 0100007F is 127.0.0.1, and tcp6 rows carry four such words. */
export function isLoopbackHex(addr: string): boolean {
  const hex = addr.toUpperCase();
  const lastByte = (word: string): number => Number.parseInt(word.slice(6, 8), 16);
  if (hex.length === 8) return lastByte(hex) === 127;
  if (hex.length !== 32) return false;
  const words = [hex.slice(0, 8), hex.slice(8, 16), hex.slice(16, 24), hex.slice(24, 32)];
  if (words[0] !== "00000000" || words[1] !== "00000000") return false;
  if (words[2] === "00000000") return words[3] === "01000000";
  return words[2] === "FFFF0000" && lastByte(words[3]!) === 127;
}

/**
 * Parses /proc/net/tcp (or tcp6; same layout, wider address) into LISTEN rows.
 * /proc/net/tcp carries socket inodes, not pids; pass an inode->pid map built
 * from a /proc/[pid]/fd scan to resolve owners.
 */
export function parseProcNetTcp(text: string, inodeToPid?: Map<number, number>): ListeningPort[] {
  const rows: ListeningPort[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== TCP_LISTEN) continue;
    const local = f[1]!.split(":");
    const port = Number.parseInt(local[local.length - 1]!, 16);
    const inode = Number(f[9]);
    if (!Number.isFinite(port) || !Number.isFinite(inode)) continue;
    rows.push({ port, inode, uid: Number(f[7]), pid: inodeToPid?.get(inode) ?? null, loopback: isLoopbackHex(local[0] ?? "") });
  }
  return rows;
}

export type PortSnapshotSource = () => Promise<ListeningPort[]>;

/** Linux-only default source. Never called in tests; darwin feeds fixtures instead. */
export function procNetTcpSource(procRoot = "/proc"): PortSnapshotSource {
  return async () => {
    const texts = await Promise.all(
      [`${procRoot}/net/tcp`, `${procRoot}/net/tcp6`].map(p => readFile(p, "utf8").catch(() => "")),
    );
    const inodeToPid = await scanSocketInodes(procRoot);
    const byPort = new Map<number, ListeningPort>();
    for (const text of texts) {
      for (const row of parseProcNetTcp(text, inodeToPid)) {
        if (!byPort.has(row.port)) byPort.set(row.port, row);
      }
    }
    return Promise.all([...byPort.values()].map(async row => {
      if (row.pid === null) return row;
      const [process, command] = await Promise.all([readComm(procRoot, row.pid), readCmdline(procRoot, row.pid)]);
      return { ...row, ...(process !== undefined ? { process } : {}), ...(command !== undefined ? { command } : {}) };
    }));
  };
}

async function readComm(procRoot: string, pid: number): Promise<string | undefined> {
  const comm = (await readFile(`${procRoot}/${pid}/comm`, "utf8").catch(() => "")).trim();
  return comm.length > 0 ? comm : undefined;
}

/** cmdline can run to ARG_MAX (2 MiB) and goes on the wire in every close; the read stops here and a cut argv ends with an ellipsis. */
export const CMDLINE_CAP_BYTES = 512;

// cmdline separates argv with NUL bytes and ends with one.
async function readCmdline(procRoot: string, pid: number): Promise<string | undefined> {
  const buf = Buffer.alloc(CMDLINE_CAP_BYTES + 1);
  let bytesRead = 0;
  try {
    const fh = await open(`${procRoot}/${pid}/cmdline`);
    try {
      ({ bytesRead } = await fh.read(buf, 0, buf.length, 0));
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
  const kept = buf.subarray(0, Math.min(bytesRead, CMDLINE_CAP_BYTES)).toString("utf8");
  const command = kept.split("\0").filter(a => a.length > 0).join(" ");
  if (command.length === 0) return undefined;
  return bytesRead > CMDLINE_CAP_BYTES ? `${command}…` : command;
}

/** Signal 0 delivers nothing and reports whether the pid exists; EPERM means it does, under another user. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// pgrep does not exist in the guests; walking /proc/[pid]/fd is the portable way.
async function scanSocketInodes(procRoot: string): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const pids = (await readdir(procRoot).catch(() => [])).filter(d => /^\d+$/.test(d));
  for (const pidDir of pids) {
    const pid = Number(pidDir);
    const fds = await readdir(`${procRoot}/${pidDir}/fd`).catch(() => []);
    for (const fd of fds) {
      const target = await readlink(`${procRoot}/${pidDir}/fd/${fd}`).catch(() => "");
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m) map.set(Number(m[1]), pid);
    }
  }
  return map;
}

export type PortOpenEvent = Extract<DaemonEvent, { type: "port.open" }>;
export type PortCloseEvent = Extract<DaemonEvent, { type: "port.close" }>;

export class PortWatcher extends EventEmitter {
  private source: PortSnapshotSource;
  private intervalMs: number;
  private alive: (pid: number) => boolean;
  private now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private known = new Map<number, ListeningPort>();
  /** A poll awaited while one is in flight joins it: the first ports.watch reply must carry the seed, not race it. */
  private inflight: Promise<void> | undefined;
  /** The first poll seeds what is already listening without events: a listener that predates the watcher is not a change. */
  private primed = false;

  constructor(source: PortSnapshotSource, opts: { intervalMs?: number; alive?: (pid: number) => boolean; now?: () => number } = {}) {
    super();
    this.source = source;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.alive = opts.alive ?? pidAlive;
    this.now = opts.now ?? Date.now;
  }

  current(): ListeningPort[] {
    return [...this.known.values()];
  }

  poll(): Promise<void> {
    return (this.inflight ??= this.diff().finally(() => {
      this.inflight = undefined;
    }));
  }

  private async diff(): Promise<void> {
    const next = new Map((await this.source()).map(p => [p.port, p] as const));
    if (!this.primed) {
      this.primed = true;
      this.known = next;
      return;
    }
    for (const [port, row] of next) {
      if (!this.known.has(port)) {
        // The wire has no null pid: an owner the fd scan could not name is left out, like its comm.
        this.emit("port.open", {
          type: "port.open",
          port,
          ...(row.pid !== null ? { pid: row.pid } : {}),
          ...(row.process !== undefined ? { process: row.process } : {}),
          loopback: row.loopback,
        } satisfies PortOpenEvent);
      }
    }
    for (const [port, row] of this.known) {
      if (!next.has(port)) this.emit("port.close", this.closeEvent(port, row));
    }
    this.known = next;
  }

  /** The close names the last row's holder, since /proc no longer has the socket to ask. */
  private closeEvent(port: number, row: ListeningPort): PortCloseEvent {
    const at = new Date(this.now()).toISOString();
    if (row.pid === null) return { type: "port.close", port, at };
    return {
      type: "port.close",
      port,
      pid: row.pid,
      ...(row.process !== undefined ? { process: row.process } : {}),
      ...(row.command !== undefined ? { command: row.command } : {}),
      exited: !this.alive(row.pid),
      at,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll().catch(() => {}), this.intervalMs);
    this.timer.unref();
    void this.poll().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
