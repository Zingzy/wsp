import { EventEmitter } from "node:events";
import { readdir, readFile, readlink } from "node:fs/promises";
import type { DaemonEvent } from "@wsp/protocol";

export interface ListeningPort {
  port: number;
  pid: number | null;
  inode: number;
  uid: number;
  /** /proc/<pid>/comm of the owner; unset when there is no pid or the read fails. */
  process?: string;
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
      const process = row.pid === null ? undefined : await readComm(procRoot, row.pid);
      return process === undefined ? row : { ...row, process };
    }));
  };
}

async function readComm(procRoot: string, pid: number): Promise<string | undefined> {
  const comm = (await readFile(`${procRoot}/${pid}/comm`, "utf8").catch(() => "")).trim();
  return comm.length > 0 ? comm : undefined;
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
  private timer: NodeJS.Timeout | null = null;
  private known = new Map<number, ListeningPort>();
  /** A poll awaited while one is in flight joins it: the first ports.watch reply must carry the seed, not race it. */
  private inflight: Promise<void> | undefined;
  /** The first poll seeds what is already listening without events: a listener that predates the watcher is not a change. */
  private primed = false;

  constructor(source: PortSnapshotSource, opts: { intervalMs?: number } = {}) {
    super();
    this.source = source;
    this.intervalMs = opts.intervalMs ?? 1000;
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
    for (const port of this.known.keys()) {
      if (!next.has(port)) this.emit("port.close", { type: "port.close", port } satisfies PortCloseEvent);
    }
    this.known = next;
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
