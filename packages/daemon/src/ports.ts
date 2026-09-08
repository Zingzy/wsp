import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { open, readdir, readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { DaemonEvent } from "@wsp/protocol";

const run = promisify(execFile);

export interface ListeningPort {
  port: number;
  pid: number | null;
  /** The socket's inode on the /proc road, which is how a pid is found there; the lsof road names the pid itself and carries none. */
  inode?: number;
  uid: number;
  /** /proc/<pid>/comm of the owner; unset when there is no pid or the read fails. */
  process?: string;
  /** /proc/<pid>/cmdline of the owner joined by spaces, at most CMDLINE_CAP_BYTES of it; unset like process. */
  command?: string;
  /** Bound to 127.0.0.1 or ::1 (or ::ffff:127.0.0.1) only: a sign-in callback listener; unreachable through the preview edge. */
  loopback: boolean;
}

const TCP_LISTEN = "0A";

/** Whether a listening address reaches only this computer: 127.0.0.0/8 or ::1, the IPv4-mapped form of either
 * included. The one rule, over the address bytes in network order; each road parses its own encoding down to them. */
function isLoopbackBytes(bytes: readonly number[]): boolean {
  if (bytes.length === 4) return bytes[0] === 127;
  if (bytes.length !== 16) return false;
  if (bytes.slice(0, 10).some(b => b !== 0)) return false;
  if (bytes[10] === 0xff && bytes[11] === 0xff) return isLoopbackBytes(bytes.slice(12));
  return bytes.slice(10).every((b, i) => b === (i === 5 ? 1 : 0));
}

/** The address bytes behind /proc/net/tcp's address column: each 32-bit word is printed little-endian in hex, so
 * 0100007F is 127.0.0.1 and a tcp6 row carries four such words. Empty for a column of any other width. */
function hexAddressBytes(addr: string): number[] {
  if (addr.length !== 8 && addr.length !== 32) return [];
  const bytes: number[] = [];
  for (let word = 0; word < addr.length; word += 8) {
    for (let byte = 6; byte >= 0; byte -= 2) bytes.push(Number.parseInt(addr.slice(word + byte, word + byte + 2), 16));
  }
  return bytes;
}

export function isLoopbackHex(addr: string): boolean {
  return isLoopbackBytes(hexAddressBytes(addr));
}

/** The address bytes behind a numeric host as lsof prints it: a dotted quad, an IPv6 address with its brackets
 * already off, or an IPv4-mapped one. Empty for a wildcard and for anything that does not parse. */
function hostAddressBytes(host: string): number[] {
  if (host === "" || host === "*") return [];
  const quad = (text: string): number[] => {
    const parts = text.split(".").map(Number);
    return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : [];
  };
  if (!host.includes(":")) return quad(host);
  const [head = "", tail, extra] = host.split("::");
  if (extra !== undefined) return [];
  const groups = (text: string): number[] | null => {
    const bytes: number[] = [];
    for (const group of text.split(":").filter(g => g !== "")) {
      if (group.includes(".")) {
        const mapped = quad(group);
        if (mapped.length === 0) return null;
        bytes.push(...mapped);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      const value = Number.parseInt(group, 16);
      bytes.push(value >> 8, value & 0xff);
    }
    return bytes;
  };
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  if (left === null || right === null) return [];
  const gap = 16 - left.length - right.length;
  if (tail === undefined ? gap !== 0 : gap < 0) return [];
  return [...left, ...Array<number>(gap).fill(0), ...right];
}

export const isLoopbackHost = (host: string): boolean => isLoopbackBytes(hostAddressBytes(host));

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

/** lsof's field output for the listening TCP sockets this user can see: numeric hosts and ports, untruncated
 * command names, and one field per line. A process set opens with its pid and carries its command and uid; each
 * socket under it opens with its fd and carries its address. */
const LSOF_ARGS = ["-nP", "-w", "+c", "0", "-F", "pcfnu", "-iTCP", "-sTCP:LISTEN"];

/** lsof field output into LISTEN rows. The fd lines only separate one socket from the next; a row is the process
 * set's pid, command and uid with that socket's address. */
export function parseLsofListeners(text: string): ListeningPort[] {
  const rows: ListeningPort[] = [];
  let held: { pid: number | null; uid: number; process?: string } = { pid: null, uid: 0 };
  for (const line of text.split("\n")) {
    const value = line.slice(1);
    switch (line[0]) {
      case "p":
        held = { pid: Number.parseInt(value, 10), uid: 0 };
        break;
      case "c":
        if (value !== "") held.process = value;
        break;
      case "u":
        held.uid = Number.parseInt(value, 10) || 0;
        break;
      case "n": {
        const cut = value.lastIndexOf(":");
        const port = Number.parseInt(value.slice(cut + 1), 10);
        if (cut < 0 || !Number.isFinite(port)) break;
        const host = value.slice(0, cut).replace(/^\[|\]$/g, "");
        rows.push({ port, pid: Number.isFinite(held.pid) ? held.pid : null, uid: held.uid, ...(held.process !== undefined ? { process: held.process } : {}), loopback: isLoopbackHost(host) });
        break;
      }
      default:
        break;
    }
  }
  return rows;
}

/** The darwin road: /proc does not exist there, so lsof names the listeners. It reports the holder's command name
 * but not its argv, so a row from this road carries no command; lsof exits non-zero when nothing is listening, and
 * whatever it printed before that is still read. */
export function lsofSource(): PortSnapshotSource {
  return async () => {
    const printed = await run("lsof", LSOF_ARGS, { maxBuffer: 8 * 1024 * 1024 }).then(
      r => r.stdout,
      (e: { stdout?: string }) => e.stdout ?? "",
    );
    const byPort = new Map<number, ListeningPort>();
    for (const row of parseLsofListeners(printed)) {
      if (!byPort.has(row.port)) byPort.set(row.port, row);
    }
    return [...byPort.values()];
  };
}

/** The road to this computer's listening ports, one module per platform: Linux reads /proc/net/tcp, macOS asks
 * lsof. A platform with no road here reads empty rather than failing the daemon that asked, so a pane on it shows
 * no ports instead of no daemon. Adding a platform is a row here and its source. */
const PORT_SOURCES: Partial<Record<NodeJS.Platform, () => PortSnapshotSource>> = {
  linux: () => procNetTcpSource(),
  darwin: () => lsofSource(),
};

export function portSourceFor(platform: NodeJS.Platform): PortSnapshotSource {
  const road = PORT_SOURCES[platform];
  return road === undefined ? async () => [] : road();
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
