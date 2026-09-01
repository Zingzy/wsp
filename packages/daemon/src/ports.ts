import { EventEmitter } from "node:events";
import { readdir, readFile, readlink } from "node:fs/promises";

export interface ListeningPort {
  port: number;
  pid: number | null;
  inode: number;
  uid: number;
}

const TCP_LISTEN = "0A";

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
    rows.push({ port, inode, uid: Number(f[7]), pid: inodeToPid?.get(inode) ?? null });
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
    return [...byPort.values()];
  };
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

export interface PortOpenEvent {
  type: "port.open";
  port: number;
  pid: number | null;
}
export interface PortCloseEvent {
  type: "port.close";
  port: number;
}

export class PortWatcher extends EventEmitter {
  private source: PortSnapshotSource;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private known = new Map<number, ListeningPort>();
  private polling = false;

  constructor(source: PortSnapshotSource, opts: { intervalMs?: number } = {}) {
    super();
    this.source = source;
    this.intervalMs = opts.intervalMs ?? 1000;
  }

  current(): ListeningPort[] {
    return [...this.known.values()];
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const next = new Map((await this.source()).map(p => [p.port, p] as const));
      for (const [port, row] of next) {
        if (!this.known.has(port)) {
          this.emit("port.open", { type: "port.open", port, pid: row.pid } satisfies PortOpenEvent);
        }
      }
      for (const port of this.known.keys()) {
        if (!next.has(port)) this.emit("port.close", { type: "port.close", port } satisfies PortCloseEvent);
      }
      this.known = next;
    } finally {
      this.polling = false;
    }
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
